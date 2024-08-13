#!/usr/bin/env node

/*
 * MCP-CAN-Boot Flash-App
 *
 * Flash application for MCP-CAN-Boot, a CAN bus bootloader for
 * AVR microcontrollers attached to an MCP2515 CAN controller.
 *
 * Copyright (C) 2020-2024 Peter Müller <peter@crycode.de> (https://crycode.de)
 * License: CC BY-NC-SA 4.0
 */

const fs = require('fs');
const yargs = require('yargs');
const socketcan = require('socketcan');
const MemoryMap = require('nrf-intel-hex');
const cliProgress = require('cli-progress');

const BOOTLOADER_CMD_VERSION = 0x01;

const CAN_DATA_BYTE_MCU_ID_MSB   = 0;
const CAN_DATA_BYTE_MCU_ID_LSB   = 1;
const CAN_DATA_BYTE_CMD          = 2;
const CAN_DATA_BYTE_LEN_AND_ADDR = 3;

const CAN_ID_MCU_TO_REMOTE_DEFAULT = 0x1FFFFF01;
const CAN_ID_REMOTE_TO_MCU_DEFAULT = 0x1FFFFF02;

const CAN_PING_INTERVAL_DEFAULT = 75;

const CMD_PING                     = 0b00000000; // remote -> mcu
const CMD_BOOTLOADER_START         = 0b00000010; // mcu -> remote
const CMD_FLASH_INIT               = 0b00000110; // remote -> mcu
const CMD_FLASH_READY              = 0b00000100; // mcu -> remote
const CMD_FLASH_SET_ADDRESS        = 0b00001010; // remote -> mcu
const CMD_FLASH_ADDRESS_ERROR      = 0b00001011; // mcu -> remote
const CMD_FLASH_DATA               = 0b00001000; // remote -> mcu
const CMD_FLASH_DATA_ERROR         = 0b00001101; // mcu -> remote
const CMD_FLASH_DONE               = 0b00010000; // remote -> mcu
const CMD_FLASH_DONE_VERIFY        = 0b01010000; // remote <-> mcu
const CMD_FLASH_ERASE              = 0b00100000; // remote -> mcu
const CMD_FLASH_READ               = 0b01000000; // remote -> mcu
const CMD_FLASH_READ_DATA          = 0b01001000; // mcu -> remote
const CMD_FLASH_READ_ADDRESS_ERROR = 0b01001011; // mcu -> remote
const CMD_START_APP                = 0b10000000; // mcu <-> remote

const STATE_INIT     = 0;
const STATE_FLASHING = 1;
const STATE_READING  = 2;

class FlashApp {

  constructor () {
    this.args = yargs
      .locale('en')

      .option('file', {
        alias: 'f',
        description: 'Hex file to flash',
        type: 'string',
        demandOption: true,
        requiresArg: true
      })

      .option('iface', {
        alias: 'i',
        description: 'CAN interface to use',
        type: 'string',
        default: 'can0',
        requiresArg: true
      })

      .option('partno', {
        alias: 'p',
        description: 'Specific AVR device like in avrdude',
        type: 'string',
        demandOption: true,
        requiresArg: true
      })

      .option('mcuid', {
        alias: 'm',
        description: 'ID of the MCU bootloader',
        type: 'string',
        demandOption: true,
        requiresArg: true,
        coerce: this.parseNumber
      })

      .option('e', {
        description: 'Erase whole flash before flashing new data',
        type: 'boolean'
      })

      .option('V', {
        description: 'Do not verify',
        type: 'boolean'
      })

      .option('r', {
        description: 'Read flash and save to given file (no flashing!), optional with maximum address to read until',
        type: 'string',
        coerce: this.parseNumber
      })

      .option('F', {
        description: 'Force flashing, even if the bootloader version missmatched',
        type: 'boolean'
      })

      .option('reset', {
        alias: 'R',
        description: 'CAN message to send on startup to reset the MCU (<can_id>#{hex_data})',
        type: 'string',
        requiresArg: true,
      })

      .option('can-id-mcu', {
        description: 'CAN-ID for messages from MCU to remote',
        type: 'string',
        default: CAN_ID_MCU_TO_REMOTE_DEFAULT,
        requiresArg: true,
        coerce: this.parseNumber
      })

      .option('can-id-remote', {
        description: 'CAN-ID for messages from remote to MCU',
        type: 'string',
        default: CAN_ID_REMOTE_TO_MCU_DEFAULT,
        requiresArg: true,
        coerce: this.parseNumber
      })

      .option('sff', {
        description: 'Use Standad Frame Format (SFF) instead of the default Extended Frame Format (EFF) for the CAN-IDs',
        type: 'boolean'
      })

      .option('ping', {
        description: 'Send a ping in the given interval (ms) to keep the bus active (should be used if the bootloader uses bitrate detection)',
        type: 'number'
      })

      .option('verbose', {
        alias: 'v',
        description: 'Enable verbose logging output',
        type: 'boolean'
      })

      .help()
      .version(false)
      .alias('help', 'h')

      .usage(`
= MCP-CAN-Boot Flash-App =
Flash application for MCP-CAN-Boot, a CAN bus bootloader for AVR microcontrollers attached to an MCP2515 CAN controller.

https://github.com/crycode-de/mcp-can-boot`)
      .example('$0 -f firmware.hex -p m1284p -m 0x0042')
      .example('$0 -f firmware.hex -p m1284p -m 0x0042 --reset 020040FF#4201FA')
      .example('$0 -r -f - -p m328p -m 0x0042')
      .argv;

    // create a new progress bar instance and use legacy theme
    this.progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.legacy);
    this.doProgress = !this.args.verbose;

    this.mcuId = [(this.args.mcuid >> 8) & 0xFF, this.args.mcuid & 0xFF];

    this.doErase = !!this.args.e;
    this.doRead = (this.args.r !== undefined) ? true : false;

    this.doVerify = this.doRead ? false : !this.args.V; // if we are just reading, we cannot verify

    // get default time for ping, if ping is set but without a time
    if (Object.prototype.hasOwnProperty.call(this.args, 'ping') && typeof this.args.ping !== 'number') {
      this.args.ping = CAN_PING_INTERVAL_DEFAULT;
    }

    this.state = STATE_INIT;
    this.deviceSignature = null;
    this.deviceFlashSize = 0;
    this.loadDeviceInfo(this.args.partno);

    if (!this.doRead) {
      // load from file if we are not only reading the flash
      if (!fs.existsSync(this.args.file)) {
        console.log(`Input file ${this.args.file} does not exist!`);
        this.exit(1);
      }
      const intelHexString = fs.readFileSync(this.args.file, 'latin1');
      this.memMap = MemoryMap.fromHex(intelHexString);

    } else {
      // we are only reading the flash... init an empty memory map
      this.memMap = new MemoryMap();

      // check if output file exists
      if (this.args.file !== '-' && fs.existsSync(this.args.file)) {
        console.log(`Output file ${this.args.file} already exists!`);
        this.exit(1);
      }
    }

    this.memMapKeys = this.memMap.keys(); // load all keys of the memory map
    this.memMapCurrentKey = null; // set current key to null to begin new key on flash ready
    this.memMapCurrentDataIdx = 0;
    this.memMapTotalBytes = 0;
    // compute input file size in bytes
    for (const block of this.memMap.values()) {
      this.memMapTotalBytes += block.length;
    }

    this.curAddr = 0x0000; // current flash address

    this.readDataArr = [];

    this.can = socketcan.createRawChannel(this.args.iface, true);
    this.can.addListener('onMessage', this.handleCanMsg.bind(this));
    this.can.start();

    // send can message to reset the mcu?
    if (this.args.reset) {
      const [canIdStr, dataStr] = this.args.reset.split('#');

      const canId = parseInt(canIdStr, 16);
      if ((canIdStr.length !== 3 && canIdStr.length !== 8) || isNaN(canId)) {
        console.log(`Reset message format error!\nThe can_id is not valid. A three digits standard frame or eight digits extended frame hex id must be provided.`);
        this.exit(1);
      }

      const data = dataStr ? dataStr.match(/../g).map((d) => {
        const n = parseInt(d, 16);
        if (isNaN(n)) {
          console.log(`Reset message format error!\nThe data bytes must be provided as hex numbers.`);
          this.exit(1);
        }
        return n;
      }) : [];

      this.can.send({
        id: canId,
        ext: (canIdStr.length > 3),
        rtr: false,
        data: Buffer.from(data)
      });

      console.log(`Reset message send to the MCU.`);
    }

    // send ping messages?
    if (this.args.ping) {
      console.log(`Sending a ping message every ${this.args.pings} ms.`);
      this.pingInterval = setInterval(() => {
        this.can.send({
          id: this.args.canIdRemote,
          ext: !this.args.sff,
          rtr: false,
          data: Buffer.from([
            this.mcuId[0],
            this.mcuId[1],
            CMD_PING,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00
          ])
        });
      }, this.args.ping);
    }

    console.log(`Waiting for bootloader start message for MCU ID ${this.hexString(this.args.mcuid, 4)} ...`);
  }

  handleCanMsg (msg) {
    if (msg.data.length !== 8) return;
    if (msg.id !== this.args.canIdMcu) return;

    const mcuid = msg.data[CAN_DATA_BYTE_MCU_ID_LSB] + (msg.data[CAN_DATA_BYTE_MCU_ID_MSB] << 8);

    if (mcuid !== this.args.mcuid) return;

    // the message is for this bootloader session

    let byteCount, addrPart;
    switch (this.state) {
      case STATE_INIT:
        switch (msg.data[CAN_DATA_BYTE_CMD]) {
          case CMD_BOOTLOADER_START:
            // check device signature
            if (msg.data[4] !== this.deviceSignature[0] || msg.data[5] !== this.deviceSignature[1] || msg.data[6] !== this.deviceSignature[2]) {
              console.log('Error: Got bootloader start message but device signature missmatched!');
              console.log(`Expected ${this.hexString(this.deviceSignature[0])} ${this.hexString(this.deviceSignature[1])} ${this.hexString(this.deviceSignature[2])} for ${this.args.partno}, got ${this.hexString(msg.data[4])} ${this.hexString(msg.data[5])} ${this.hexString(msg.data[6])}`);
              return;
            }

            // check bootloader version
            if (msg.data[7] !== BOOTLOADER_CMD_VERSION) {
              if (this.args.F) {
                console.warn(`WARNING: Bootloader command version of MCU ${this.hexString(msg.data[7])} does not match the version expected by this flash app ${this.hexString(BOOTLOADER_CMD_VERSION)}. You forced flashing anyways. This may lead to a stupid result...`);
              } else {
                console.warn(`ERROR: Bootloader command version of MCU ${this.hexString(msg.data[7])} does not match the version expected by this flash app ${this.hexString(BOOTLOADER_CMD_VERSION)}. To force flashing use the -F argument.`);
                return;
              }
            }

            // enter flash mode
            console.log('Got bootloader start, entering flash mode ...');
            if (this.pingInterval) {
              clearInterval(this.pingInterval);
              this.pingInterval = undefined;
              console.log(`Stopped sending of ping messages.`);
            }
            this.flashStartTs = Date.now();
            this.can.send({
              id: this.args.canIdRemote,
              ext: !this.args.sff,
              rtr: false,
              data: Buffer.from([
                this.mcuId[0],
                this.mcuId[1],
                CMD_FLASH_INIT,
                0x00,
                this.deviceSignature[0],
                this.deviceSignature[1],
                this.deviceSignature[2],
                0x00
              ])
            });
            break;

          case CMD_FLASH_READY:
            // flash is ready for first data, read or erase...
            if (this.doRead) {
              console.log('Querying bootloader size ...');
              // determine size of bootloader section by trying to set the
              // flash address to 0xFFFFFFFF (huge address that's out of bounds).
              // bootloader will repond with CMD_FLASH_ADDRESS_ERROR that will
              // inform us of FLASHEND_BL (last address of the program space).
              // we can use that value and the known size of the chip's flash
              // memory to determine the bootloader size.
              this.sendSetFlashAddress(0xFFFFFFFF);
            } else if (this.doErase) {
              console.log('Got flash ready message, erasing flash ...');
              this.can.send({
                id: this.args.canIdRemote,
                ext: !this.args.sff,
                rtr: false,
                data: Buffer.from([
                  this.mcuId[0],
                  this.mcuId[1],
                  CMD_FLASH_ERASE,
                  0x00,
                  0x00,
                  0x00,
                  0x00,
                  0x00
                ])
              });
              this.doErase = false;
            } else {
              console.log('Got flash ready message, begin flashing ...');
              this.state = STATE_FLASHING;
              this.onFlashReady(msg.data);
            }
            break;

          case CMD_FLASH_ADDRESS_ERROR:
            if (this.doRead) {
              // get FLASHEND_BL from error response (last address of program space).
              // use it to recover the size of the program/bootloader sections.
              const flashendBL =
                (msg.data[4] << 24) |
                (msg.data[5] << 16) |
                (msg.data[6] << 8) |
                msg.data[7];
              const progSize = flashendBL + 1;
              const blSize = this.deviceFlashSize - progSize;
              console.log(`Bootloader size: ${blSize} bytes`);

              // determine read size (default to full program memory size)
              let readSizeBytes = progSize;
              if (this.args.r) {
                if (this.args.r >= progSize) {
                  console.warn(`WARNING: read size of ${this.args.r} exceeds program memory size of ${progSize}`);
                } else {
                  readSizeBytes = this.args.r;// user specified max read address
                }
              }
              this.progressStart(readSizeBytes, 0);
              this.state = STATE_READING;
              this.can.send({
                id: this.args.canIdRemote,
                ext: !this.args.sff,
                rtr: false,
                data: Buffer.from([
                  this.mcuId[0],
                  this.mcuId[1],
                  CMD_FLASH_READ,
                  0x00,
                  0x00,
                  0x00,
                  0x00,
                  0x00
                ])
              });
            } else {
              console.warn('WARNING: unexpected CMD_FLASH_ADDRESS_ERROR in STATE_INIT');
            }
            break;

          default:
            // something wrong?
            console.warn(`WARNING: Got unexpected message from MCU: ${this.hexString(msg.data[CAN_DATA_BYTE_CMD])}`);
        }

        break;

      case STATE_FLASHING:

        switch (msg.data[CAN_DATA_BYTE_CMD]) {
          case CMD_FLASH_DATA_ERROR:
            console.log('Flash data error!');
            console.log('Maybe there are some CAN bus issues?');
            break;

          case CMD_FLASH_ADDRESS_ERROR:
            console.log('Flash address error!');
            console.log('Maybe the hex file is not for this MCU type or the application is too large to be used together with the bootloader?');
            break;

          case CMD_FLASH_READY:
            byteCount = (msg.data[CAN_DATA_BYTE_LEN_AND_ADDR] >> 5);
            // console.log(`${byteCount} bytes flashed`);
            this.progressIncrement(byteCount);
            this.curAddr += byteCount;
            this.memMapCurrentDataIdx += byteCount;
            this.onFlashReady(msg.data);
            break;

          case CMD_START_APP:
            console.log(`Flash done in ${(Date.now() - this.flashStartTs)} ms.`);
            console.log('MCU is starting the app. :-)');
            this.exit(0);
            break;

          default:
            // something wrong?
            console.warn(`WARNING: Got unexpected message from MCU: ${this.hexString(msg.data[CAN_DATA_BYTE_CMD])}`);
        }
        break;

      case STATE_READING:
        switch (msg.data[CAN_DATA_BYTE_CMD]) {
          case CMD_FLASH_DONE_VERIFY:
            // start reading flash to verify
            console.log('Start reading flash to verify ...');
            this.progressStart(this.memMapTotalBytes, 0);
            // TODO
            this.memMapKeys = this.memMap.keys(); // load all keys of the memory map
            this.memMapCurrentKey = null; // set current key to null to begin new key on flash read
            this.memMapCurrentDataIdx = 0;

            this.readForVerify ();

            break;

          case CMD_FLASH_READ_DATA:
            byteCount = (msg.data[CAN_DATA_BYTE_LEN_AND_ADDR] >> 5);
            addrPart = msg.data[CAN_DATA_BYTE_LEN_AND_ADDR] & 0b00011111;

            if (this.curAddr & 0b00011111 !== addrPart) {
              console.log('Got an unexpected address of read data from MCU!');
              console.log('Will now abort and exit the bootloader ...');
              this.sendStartApp();
              return;
            }

            if (this.args.verbose) {
              console.log(`Got flash data for ${this.hexString(this.curAddr, 4)} ...`);
            }
            this.progressIncrement(byteCount);

            if (this.doVerify) {
              // verify flash
              for (let i = 0; i < byteCount; i++) {
                if (this.memMap.get(this.memMapCurrentKey)[this.memMapCurrentDataIdx] !== undefined
                  && this.memMap.get(this.memMapCurrentKey)[this.memMapCurrentDataIdx] !== msg.data[4+i]) {
                  console.log(`ERROR: Verify failed at ${this.hexString(this.curAddr)}!`);
                  console.log('Trying to start the app nevertheless ...');
                  this.sendStartApp();
                  return;
                }
                this.curAddr++;
                this.memMapCurrentDataIdx++;
              }

              this.readForVerify();

            } else {
              // read whole flash
              // cache the data
              for (let i = 0; i < byteCount; i++) {
                this.readDataArr.push(msg.data[4+i]);
                this.curAddr++;
              }

              if (this.args.r > 0 && this.curAddr > this.args.r) {
                // reached max read address...
                this.readDone();
                return;
              }
              // request next address
              this.can.send({
                id: this.args.canIdRemote,
                ext: !this.args.sff,
                rtr: false,
                data: Buffer.from([
                  this.mcuId[0],
                  this.mcuId[1],
                  CMD_FLASH_READ,
                  0x00,
                  (this.curAddr >> 24) & 0xFF,
                  (this.curAddr >> 16) & 0xFF,
                  (this.curAddr >> 8) & 0xFF,
                  this.curAddr & 0xFF
                ])
              });
            }


            break;

          case CMD_FLASH_READ_ADDRESS_ERROR:
            // we hit the end of the flash
            if (this.doVerify) {
              // hitting the end at verify must be an error...
              console.log('ERROR: Reading flash failed during verify!');
              this.sendStartApp();
              return;
            } else {
              // when reading whole flash this is expected
              this.readDone();
            }

            break;

          case CMD_START_APP:
            console.log('MCU is starting the app. :-)');
            this.exit(0);
            break;

          default:
            // something wrong?
            console.warn(`WARNING: Got unexpected message from MCU: ${this.hexString(msg.data[CAN_DATA_BYTE_CMD])}`);
        }
        break;
    }
  }

  readForVerify () {
    // check memory map and get next map key if we reached the end
    if (!this.memMap.get(this.memMapCurrentKey) || this.memMap.get(this.memMapCurrentKey)[this.memMapCurrentDataIdx] === undefined) {
      // no more data... goto next memory map key...
      const key = this.memMapKeys.next();
      if (key.done) {
        // all keys done... verify complete
        this.progressStop();
        console.log(`Flash and verify done in ${(Date.now() - this.flashStartTs)} ms.`);
        this.sendStartApp();
        return;
      }

      // apply new current address and set data index to 0
      this.memMapCurrentKey = key.value;
      this.memMapCurrentDataIdx = 0;
      this.curAddr = key.value;
    }

    // request next address
    this.can.send({
      id: this.args.canIdRemote,
      ext: !this.args.sff,
      rtr: false,
      data: Buffer.from([
        this.mcuId[0],
        this.mcuId[1],
        CMD_FLASH_READ,
        0x00,
        (this.curAddr >> 24) & 0xFF,
        (this.curAddr >> 16) & 0xFF,
        (this.curAddr >> 8) & 0xFF,
        this.curAddr & 0xFF
      ])
    });
  }

  readDone () {
    this.progressStop();

    // create memory map
    const memMap = new MemoryMap();
    memMap.set(0x0000, Uint8Array.from(this.readDataArr));

    const intelHexString = memMap.asHexString();

    if (this.args.file === '-') {
      // write to stdout
      console.log('Read hex data:');
      console.log(intelHexString);
    } else {
      fs.writeFileSync(this.args.file, intelHexString, 'latin1');
      console.log(`Hex file written to ${this.args.file}.`);
    }

    console.log(`Reading flash done in ${Date.now() - this.flashStartTs} ms.`);

    // start the main application at the MCU
    this.sendStartApp();
  }

  sendStartApp () {
    console.log('Starting the app on the MCU ...');
    this.can.send({
      id: this.args.canIdRemote,
      ext: !this.args.sff,
      rtr: false,
      data: Buffer.from([
        this.mcuId[0],
        this.mcuId[1],
        CMD_START_APP,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00
      ])
    });
  }

  sendSetFlashAddress(addr) {
    if (this.args.verbose) {
      console.log(`Setting flash address to ${this.hexString(addr)} ...`);
    }
    this.can.send({
      id: this.args.canIdRemote,
      ext: !this.args.sff,
      rtr: false,
      data: Buffer.from([
        this.mcuId[0],
        this.mcuId[1],
        CMD_FLASH_SET_ADDRESS,
        0x00,
        (addr >> 24) & 0xFF,
        (addr >> 16) & 0xFF,
        (addr >> 8) & 0xFF,
        addr & 0xFF
      ])
    });
  }

  onFlashReady (msgData) {
    const curAddrRemote = msgData[7] + (msgData[6] << 8) + (msgData[5] << 16) + (msgData[4] << 24);
    //console.log(`Remote flash address is ${this.hexString(curAddrRemote)}`);

    if (!this.memMap.get(this.memMapCurrentKey) || this.memMap.get(this.memMapCurrentKey)[this.memMapCurrentDataIdx] === undefined) {
      // no more data... goto next memory map key...
      const key = this.memMapKeys.next();
      if (key.done) {
        // all keys done... flash complete
        this.progressStop();
        console.log('All data transmitted. Finalizing ...');
        if (this.doVerify) {
          // we want to verify... send flash done verify and set own state to read
          this.state = STATE_READING;
          this.can.send({
            id: this.args.canIdRemote,
            ext: !this.args.sff,
            rtr: false,
            data: Buffer.from([
              this.mcuId[0],
              this.mcuId[1],
              CMD_FLASH_DONE_VERIFY,
              0x00,
              0x00,
              0x00,
              0x00,
              0x00
            ])
          });

        } else {
          // we don't want to verify... send flash done to start the app
          this.can.send({
            id: this.args.canIdRemote,
            ext: !this.args.sff,
            rtr: false,
            data: Buffer.from([
              this.mcuId[0],
              this.mcuId[1],
              CMD_FLASH_DONE,
              0x00,
              0x00,
              0x00,
              0x00,
              0x00
            ])
          });
        }
        return;
      }

      // initialize progress bar on first block
      if (this.memMapCurrentKey == null) {
        this.progressStart(this.memMapTotalBytes, 0);
      }

      // apply new current address and set data index to 0
      this.memMapCurrentKey = key.value;
      this.memMapCurrentDataIdx = 0;
      this.curAddr = key.value;
    }

    if (this.curAddr !== curAddrRemote) {
      // need to set the address to flash...
      console.log(`Setting flash address to ${this.hexString(this.curAddr, 4)} ...`);
      this.sendSetFlashAddress(this.curAddr);
      return;
    }

    // send data to flash...
    const data = Buffer.from([
      this.mcuId[0],
      this.mcuId[1],
      CMD_FLASH_DATA,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00
    ]);

    // add the 4 data bytes if available
    let dataBytes = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.memMap.get(this.memMapCurrentKey)[this.memMapCurrentDataIdx+i];
      if (byte === undefined) {
        break;
      }
      data[4+i] = byte;
      dataBytes++;
    }

    // set the number of bytes and address
    data[CAN_DATA_BYTE_LEN_AND_ADDR] = (dataBytes << 5) | (this.curAddr & 0b00011111);

    // send data
    if (this.args.verbose) {
      console.log(`Sending flash data ${this.hexString(this.curAddr, 4)} ...`);
    }
    this.can.send({
      id: this.args.canIdRemote,
      ext: !this.args.sff,
      rtr: false,
      data: data
    });
  }

  hexString (num, minLength) {
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    if (minLength) {
      while (hex.length < minLength) {
        hex = '0' + hex;
      }
    }
    return '0x' + hex.toUpperCase();
  }

  parseNumber (val) {
    if (typeof(val) === 'string') {
      val = parseInt(val, val.startsWith('0x') ? 16 : 10);
    }
    return val;
  }

  progressStart(total, startValue) {
    if (this.doProgress) {
      this.progressBar.start(total, startValue);
    }
  }

  progressIncrement(incr = 1) {
    if (this.doProgress) {
      this.progressBar.increment(incr);
    }
  }

  progressStop() {
    if (this.doProgress) {
      this.progressBar.stop();
    }
  }

  loadDeviceInfo (partno) {
    partno = partno.toLowerCase();
    switch (partno) {
      case 'm32':
      case 'mega32':
      case 'atmega32':
        this.deviceSignature = [0x1E, 0x95, 0x02];
        this.deviceFlashSize = 32 * 1024;
        break;
      case 'm32u4':
      case 'mega32u4':
      case 'atmega32u4':
        this.deviceSignature = [0x1E, 0x95, 0x87];
        this.deviceFlashSize = 32 * 1024;
        break;
      case 'm328':
      case 'mega328':
      case 'atmega328':
        this.deviceSignature = [0x1E, 0x95, 0x14];
        this.deviceFlashSize = 32 * 1024;
        break;
      case 'm328p':
      case 'mega328p':
      case 'atmega328p':
        this.deviceSignature = [0x1E, 0x95, 0x0F];
        this.deviceFlashSize = 32 * 1024;
        break;
      case 'm328pb':
      case 'mega328pb':
      case 'atmega328pb':
        this.deviceSignature = [0x1E, 0x95, 0x16];
        this.deviceFlashSize = 32 * 1024;
        break;
      case 'm64':
      case 'mega64':
      case 'atmega64':
        this.deviceSignature = [0x1E, 0x96, 0x02];
        this.deviceFlashSize = 64 * 1024;
        break;
      case 'm644p':
      case 'mega644p':
      case 'atmega644p':
        this.deviceSignature = [0x1E, 0x96, 0x0A];
        this.deviceFlashSize = 64 * 1024;
        break;
      case 'm128':
      case 'mega128':
      case 'atmega128':
        this.deviceSignature = [0x1E, 0x97, 0x02];
        this.deviceFlashSize = 128 * 1024;
        break;
      case 'm1284p':
      case 'mega1284p':
      case 'atmega1284p':
        this.deviceSignature = [0x1E, 0x97, 0x05];
        this.deviceFlashSize = 128 * 1024;
        break;
      case 'm2560':
      case 'mega2560':
      case 'atmega2560':
        this.deviceSignature = [0x1E, 0x98, 0x01];
        this.deviceFlashSize = 256 * 1024;
        break;
      default:
        this.deviceSignature = [0, 0, 0];
        this.deviceFlashSize = 0 * 1024;
    }
  }

  /**
   * Do a clean exit of the flash app.
   */
  exit (code) {
    try {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
      }
      if (this.can) {
        this.can.stop();
      }
    } catch (e) {
      console.warn('Error at exit cleanup:', e);
    }
    process.exit(code);
  }
}

new FlashApp();
