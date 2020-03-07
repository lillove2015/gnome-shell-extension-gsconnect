'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('SFTP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    incomingCapabilities: ['kdeconnect.sftp'],
    outgoingCapabilities: ['kdeconnect.sftp.request'],
    actions: {
        mount: {
            label: _('Mount'),
            icon_name: 'folder-remote-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        },
        unmount: {
            label: _('Unmount'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        }
    }
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
var Plugin = GObject.registerClass({
    Name: 'GSConnectSFTPPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._gmount = null;
        this._mounting = false;

        // A reusable launcher for ssh processes
        this._launcher = new Gio.SubprocessLauncher({
            flags: (Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE)
        });

        // Watch the volume monitor
        this._volumeMonitor = Gio.VolumeMonitor.get();

        this._mountAddedId = this._volumeMonitor.connect(
            'mount-added',
            this._onMountAdded.bind(this)
        );

        this._mountRemovedId = this._volumeMonitor.connect(
            'mount-removed',
            this._onMountRemoved.bind(this)
        );
    }

    get gmount() {
        if (!this._gmount && this.device.connected) {
            let host = this.device.channel.host;

            let regex = new RegExp(
                'sftp://(' + host + '):(1739|17[4-5][0-9]|176[0-4])'
            );

            for (let mount of this._volumeMonitor.get_mounts()) {
                let uri = mount.get_root().get_uri();

                if (regex.test(uri)) {
                    this._gmount = mount;
                    this._addSubmenu(mount);
                    this._addSymlink(mount);

                    break;
                }
            }
        }

        return this._gmount;
    }

    handlePacket(packet) {
        if (packet.type === 'kdeconnect.sftp') {
            // There was an error mounting the filesystem
            if (packet.body.errorMessage) {
                this.device.showNotification({
                    id: 'sftp-error',
                    title: `${this.device.name}: ${Metadata.label}`,
                    body: packet.body.errorMessage,
                    icon: new Gio.ThemedIcon({name: 'dialog-error-symbolic'}),
                    priority: Gio.NotificationPriority.URGENT
                });

            // Ensure we don't mount on top of an existing mount
            } else {
                this.device.hideNotification('sftp-error');
                this._mount(packet.body);
            }
        }
    }

    connected() {
        super.connected();

        // Disable for all bluetooth connections
        if (this.device.connection_type !== 'lan') {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;
        } else {
            this.mount();
        }
    }

    /**
     * Add GSConnect's private key identity to the authentication agent so our
     * identity can be verified by Android during private key authentication.
     */
    _addPrivateKey() {
        let ssh_add = this._launcher.spawnv([
            gsconnect.metadata.bin.ssh_add,
            GLib.build_filenamev([gsconnect.configdir, 'private.pem'])
        ]);

        return new Promise((resolve, reject) => {
            ssh_add.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let result = proc.communicate_utf8_finish(res)[1].trim();

                    if (proc.get_exit_status() !== 0) {
                        debug(result, this.device.name);
                    }

                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Remove all host keys from ~/.ssh/known_hosts for @host in the port range
     * used by KDE Connect (1739-1764).
     *
     * This function is only called if an error occurs mounting, so ultimately
     * it rethrows that same error.
     *
     * @param {string} host - A hostname or IP address
     * @param {Error} error - The original error
     */
    async _removeHostKey(host, error) {
        let procs = [];

        for (let port = 1739; port <= 1764; port++) {
            let ssh_keygen = this._launcher.spawnv([
                gsconnect.metadata.bin.ssh_keygen,
                '-R',
                `[${host}]:${port}`
            ]);

            let proc = new Promise((resolve, reject) => {
                ssh_keygen.wait_check_async(null, (proc, res) => {
                    try {
                        proc.wait_check_finish(res);
                    } catch (e) {
                        debug(e);
                    }

                    resolve();
                });
            });

            procs.push(proc);
        }

        await Promise.all(procs);

        throw error;
    }

    _onAskQuestion(op, message, choices) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    _onAskPassword(op, message, user, domain, flags) {
        op.reply(Gio.MountOperationResult.HANDLED);
    }

    _onMountAdded(monitor, mount) {
        if (this.gmount !== null) {
            return;
        }

        let host = this.device.channel.host;
        let regex = new RegExp(
            'sftp://(' + host + '):(1739|17[4-5][0-9]|176[0-4])'
        );
        let uri = mount.get_root().get_uri();

        if (regex.test(uri)) {
            this._gmount = mount;
            this._addSubmenu(mount);
            this._addSymlink(mount);
        }
    }

    _onMountRemoved(monitor, mount) {
        if (this.gmount === mount) {
            this._gmount = null;
            this._removeSubmenu();
        }
    }

    async _mount(info) {
        try {
            if (this._mounting || this.gmount !== null)
                return;

            this._mounting = true;

            // Ensure the private key is in the keyring
            await this._addPrivateKey();

            // Create a mount operation, auto-accept new host keys and passwords
            let op = new Gio.MountOperation({
                username: info.user,
                password: info.password,
                password_save: Gio.PasswordSave.NEVER
            });

            let questionId = op.connect('ask-question', this._onAskQuestion);
            let passwordId = op.connect('ask-password', this._onAskPassword);

            // This is the actual call to mount the device
            let host = this.device.channel.host;
            let file = Gio.File.new_for_uri(`sftp://${host}:${info.port}/`);

            await new Promise((resolve, reject) => {
                file.mount_enclosing_volume(0, op, null, (file, res) => {
                    try {
                        op.disconnect(questionId);
                        op.disconnect(passwordId);
                        resolve(file.mount_enclosing_volume_finish(res));
                    } catch (e) {
                        // There's a good chance this is a host key verification
                        // error; regardless we'll remove the key for security.
                        resolve(this._removeHostKey(host, e));
                    }
                });
            });
        } catch (e) {
            logError(e, this.device.name);
        } finally {
            this._mounting = false;
        }
    }

    /**
     * Mount menu helpers
     */
    _addSubmenu(mount) {
        try {
            let uri = mount.get_root().get_uri();

            if (this._menuItem === undefined) {
                this._menuItem = new Gio.MenuItem();

                let icon = new Gio.EmblemedIcon({
                    gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'})
                });

                let emblem = new Gio.Emblem({
                    icon: new Gio.ThemedIcon({name: 'emblem-default'})
                });

                icon.add_emblem(emblem);

                this._menuItem.set_detailed_action('device.mount');
                this._menuItem.set_icon(icon);
                this._menuItem.set_label(_('Files'));
            }

            if (this._filesUri === undefined || this._filesUri !== uri) {
                this._filesUri = uri;

                let submenu = new Gio.Menu();
                submenu.append(_('Open Folder'), `device.openPath::${uri}`);
                submenu.append(_('Unmount'), 'device.unmount');

                this._menuItem.set_submenu(submenu);
            }

            this.device.replaceMenuAction('device.mount', this._menuItem);
        } catch (e) {
            logError(e, this.device.name);
        }

    }

    _removeSubmenu() {
        try {
            let index = this.device.removeMenuAction('device.mount');
            let action = this.device.lookup_action('mount');

            if (action !== null) {
                this.device.addMenuAction(
                    action,
                    index,
                    Metadata.actions.mount.label,
                    Metadata.actions.mount.icon_name
                );
            }
        } catch (e) {
            logError(e, this.device.name);
        }
    }

    /**
     * Create a symbolic link referring to the device by name
     */
    async _addSymlink(mount) {
        try {
            let by_name_dir = Gio.File.new_for_path(
                gsconnect.runtimedir + '/by-name/'
            );

            try {
                by_name_dir.make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    throw e;
                }
            }

            // Replace path separator with a Unicode lookalike:
            let safe_device_name = this.device.name.replace('/', '∕');

            if (safe_device_name === '.') {
                safe_device_name = '·';
            } else if (safe_device_name === '..') {
                safe_device_name = '··';
            }

            let link_target = mount.get_root().get_path();
            let link = Gio.File.new_for_path(
                by_name_dir.get_path() + '/' + safe_device_name
            );

            // Check for and remove any existing stale link
            try {
                let link_stat = await new Promise((resolve, reject) => {
                    link.query_info_async(
                        'standard::symlink-target',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (link, res) => {
                            try {
                                resolve(link.query_info_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        },
                    );
                });

                if (link_stat.get_symlink_target() === link_target) {
                    return;
                }

                await new Promise((resolve, reject) => {
                    link.delete_async(
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (link, res) => {
                            try {
                                resolve(link.delete_finish(res));
                            } catch (e) {
                                reject(e);
                            }
                        },
                    );
                });
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    throw e;
                }
            }

            link.make_symbolic_link(link_target, null);
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        if (this.gmount === null) {
            this.device.sendPacket({
                type: 'kdeconnect.sftp.request',
                body: {
                    startBrowsing: true
                }
            });
        }
    }

    /**
     * Remove the menu items, unmount the filesystem, replace the mount item
     */
    unmount() {
        if (this.gmount !== null) {
            let op = new Gio.MountOperation();

            this.gmount.unmount_with_operation(1, op, null, (mount, res) => {
                try {
                    mount.unmount_with_operation_finish(res);
                } catch (e) {
                    debug(e);
                }
            });
        }
    }

    destroy() {
        this._volumeMonitor.disconnect(this._mountAddedId);
        this._volumeMonitor.disconnect(this._mountRemovedId);
        this._volumeMonitor = null;

        this.unmount();
        super.destroy();
    }
});

