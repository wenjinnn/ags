import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Service from './service.js';
import { NotificationIFace } from '../dbus/notifications.js';
import { NOTIFICATIONS_CACHE_PATH, ensureDirectory, getConfig, readFile, timeout, writeFile } from '../utils.js';

interface action {
    id: string
    label: string
}

interface Hints {
    'image-data'?: GLib.Variant<'(iiibiiay)'>
    'desktop-entry'?: GLib.Variant<'s'>
    'urgency'?: GLib.Variant<'y'>
}

const _URGENCY = ['low', 'normal', 'critical'];

interface Notification {
    id: number
    appName: string
    appEntry?: string
    appIcon: string
    summary: string
    body: string
    actions: action[]
    urgency: string
    time: number
    image: string | null
    popup: boolean
}

class NotificationsService extends Service {
    static {
        Service.register(this, {
            'dismissed': ['int'],
            'notified': ['int'],
            'closed': ['int'],
        });
    }

    _dbus!: Gio.DBusExportedObject;
    _notifications: Map<number, Notification>;
    _dnd = false;
    _idCount = 0;
    _timeout = getConfig()?.notificationPopupTimeout || 3000;

    constructor() {
        super();

        this._notifications = new Map();
        this._readFromFile();
        this._register();
    }

    get dnd() {
        return this._dnd;
    }

    set dnd(value: boolean) {
        this._dnd = value;
        this.emit('changed');
    }

    get popups() {
        const map: Map<number, Notification> = new Map();
        for (const [id, notification] of this._notifications) {
            if (notification.popup)
                map.set(id, notification);
        }
        return map;
    }

    Clear() {
        for (const [id] of this._notifications)
            this.CloseNotification(id);
    }

    Notify(
        appName: string,
        replacesId: number,
        appIcon: string,
        summary: string,
        body: string,
        acts: string[],
        hints: Hints,
    ) {
        const actions: action[] = [];
        for (let i = 0; i < acts.length; i += 2) {
            if (acts[i + 1] !== '') {
                actions.push({
                    label: acts[i + 1],
                    id: acts[i],
                });
            }
        }

        const id = replacesId || this._idCount++;
        const urgency = _URGENCY[hints['urgency']?.unpack() || 1];
        this._notifications.set(id, {
            id,
            appName,
            appEntry: hints['desktop-entry']?.unpack(),
            appIcon,
            summary,
            body,
            actions,
            urgency,
            time: GLib.DateTime.new_now_local().to_unix(),
            image: this._parseImage(`${summary}${id}`, hints['image-data']) || this._isFile(appIcon),
            popup: !this._dnd,
        });

        timeout(this._timeout, () => this.DismissNotification(id));

        this._cache();
        this.emit('notified', id);
        this.emit('changed');
        return id;
    }

    DismissNotification(id: number) {
        const n = this._notifications.get(id);
        if (!n)
            return;

        n.popup = false;
        this.emit('dismissed', id);
        this.emit('changed');
    }

    CloseNotification(id: number) {
        if (!this._notifications.has(id))
            return;

        this._dbus.emit_signal('NotificationClosed', GLib.Variant.new('(uu)', [id, 3]));
        this._notifications.delete(id);
        this.emit('closed', id);
        this.emit('changed');
        this._cache();
    }

    InvokeAction(id: number, actionId: string) {
        if (!this._notifications.has(id))
            return;

        this._dbus.emit_signal('ActionInvoked', GLib.Variant.new('(us)', [id, actionId]));
        this.CloseNotification(id);
        this._cache();
    }

    GetCapabilities() {
        return ['actions', 'body', 'icon-static', 'persistence'];
    }

    GetServerInformation() {
        return new GLib.Variant('(ssss)', [
            pkg.name,
            'Aylur',
            pkg.version,
            '1.2',
        ]);
    }

    _register() {
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            'org.freedesktop.Notifications',
            Gio.BusNameOwnerFlags.NONE,
            (connection: Gio.DBusConnection) => {
                this._dbus = Gio.DBusExportedObject.wrapJSObject(NotificationIFace, this);
                this._dbus.export(connection, '/org/freedesktop/Notifications');
            },
            null,
            () => {
                print('Another notification daemon is already running, make sure you stop Dunst or any other daemon you have running');
            },
        );
    }

    _readFromFile() {
        const file = readFile(NOTIFICATIONS_CACHE_PATH + '/notifications.json');
        if (!file)
            return;

        const notifications = JSON.parse(file) as Notification[];
        notifications.forEach(n => {
            if (n.id > this._idCount)
                this._idCount = n.id + 1;

            this._notifications.set(n.id, n);
        });

        this.emit('changed');
    }

    _isFile(path: string) {
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    _parseImage(name: string, image_data?: GLib.Variant<'(iiibiiay)'>) {
        if (!image_data)
            return null;

        ensureDirectory();
        const fileName = name.replace(/[^a-zA-Z0-9]/g, '');
        const image = image_data.recursiveUnpack();
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            image[6],
            GdkPixbuf.Colorspace.RGB,
            image[3],
            image[4],
            image[0],
            image[1],
            image[2],
        );

        const output_stream =
            Gio.File.new_for_path(fileName)
                .replace(null, false, Gio.FileCreateFlags.NONE, null);

        pixbuf.save_to_streamv(output_stream, 'png', null, null, null);
        output_stream.close(null);

        return fileName;
    }

    _cache() {
        const notifications = [];
        for (const [, notification] of this._notifications) {
            const n = { ...notification, action: [], popup: false };
            notifications.push(n);
        }

        ensureDirectory();
        writeFile(JSON.stringify(notifications, null, 2), NOTIFICATIONS_CACHE_PATH + '/notifications.json');
    }
}

export default class Notifications {
    static { Service.export(this, 'Notifications'); }
    static _instance: NotificationsService;

    static get instance() {
        Service.ensureInstance(Notifications, NotificationsService);
        return Notifications._instance;
    }

    static clear() { Notifications.instance.Clear(); }
    static close(id: number) { Notifications.instance.CloseNotification(id); }
    static dismiss(id: number) { Notifications.instance.DismissNotification(id); }
    static invoke(id: number, actionId: string) { Notifications.instance.InvokeAction(id, actionId); }
    static get dnd() { return Notifications.instance.dnd; }
    static set dnd(value: boolean) { Notifications.instance.dnd = value; }
    static get popups() { return Notifications.instance.popups; }
    static get notifications() { return Notifications.instance._notifications; }
}