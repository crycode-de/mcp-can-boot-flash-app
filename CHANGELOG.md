# MCP-CAN-Boot Flash-App Changelog

## v2.2.2 2023-05-11

* Added support for ATmega32U4 mcu

## v2.2.1 2023-05-04

* Added support for sending ping messages (usefull if the bootloader uses bitrate detection)
* Added progress bars (thanks to Dan Hankewycz [#2](https://github.com/crycode-de/mcp-can-boot-flash-app/pull/2))
* Added verbose option (thanks to Dan Hankewycz [#2](https://github.com/crycode-de/mcp-can-boot-flash-app/pull/2))
* Updated dependencies

## v2.1.1 2022-07-05

* Updated error message when the hex file was too big
* Updated dependencies

## v2.1.0 2021-06-18

* Added support for Standard Frame Format (SFF) CAN-IDs  
  New argument: `-sff`

## v2.0.0 2021-06-14

### ⚠ BREAKING CHANGES

* Drop Node.js 10 support - Required Node.js version is now 12.x
* Updated dependencies

## v1.1.1 2021-02-24

* Moved repository to GitHub

## v1.1.0 2020-09-05

* Added parameter for mcu reset
