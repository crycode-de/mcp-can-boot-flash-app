const os = require('os');

class CanInterface {
  constructor() {
  }

  async open() {
    throw new Error('Not implemented.');
  }

  // eslint-disable-next-line no-unused-vars
  onMessage(callback) {
    throw new Error('Not implemented.');
  }

  // eslint-disable-next-line no-unused-vars
  async send(msg) {
    throw new Error('Not implemented.');
  }

  close() {
    throw new Error('Not implemented.');
  }
}

class CanInterfaceWindows extends CanInterface {
  constructor(iface, bitrate) {
    super();
    this.iface = iface;
    this.can = new (require('@csllc/cs-pcan-usb'))({canRate: bitrate * 1000});
  }

  async open() {
    const devices = await this.can.list();
    if (devices.length === 0)
      throw new Error('No CAN devices found.');

    let device = devices[0];

    if (this.iface) {
      device = devices.find(device => device.device_name === this.iface);

      if (!device)
        throw new Error(`CAN device with name '${this.iface}' was not found.`);
    }

    console.log('Using device:', {name: device.device_name, id: device.device_id, path: device.path});
    await this.can.open(device.path);
  }

  onMessage(callback) {
    this.can.on('data', (msg) => {
      callback({
        id: msg.id,
        data: msg.buf,
      });
    });
  }

  async send(msg) {
    this.can.write({
      id: msg.id,
      ext: msg.ext,
      buf: msg.data,
    });
  }

  async close() {
    // For some weird reason, some PCAN USB devices are sending `PCAN_ERROR_INITIALIZE` error if closing is not delayed by one tick.
    await new Promise(resolve => setTimeout(resolve, 0));
    await this.can.close();
  }
}

class CanInterfaceLinux extends CanInterface {
  constructor(iface) {
    super();
    this.can = require('socketcan').createRawChannel(iface, true);

  }

  open() {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.can.start());
      } catch (error) {
        reject(error);
      }
    });
  }

  onMessage(callback) {
    this.can.addListener('onMessage', callback);
  }

  async send(msg) {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.can.send(msg));
      } catch (error) {
        reject(error);
      }
    });
  }

  async close() {
    return new Promise((resolve, reject) => {
      try {
        resolve(this.can.stop());
      } catch (error) {
        reject(error);
      }
    });
  }
}

class CanFactory {
  static create(args) {
    switch (os.platform()) {
      case 'linux':
        return new CanInterfaceLinux(args.iface);
      case 'win32':
        return new CanInterfaceWindows(args.iface, args.bitrate);
      default:
        throw new Error('Unsupported platform');
    }
  }
}

module.exports = CanFactory;

