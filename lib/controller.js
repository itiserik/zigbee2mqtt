const MQTT = require('./mqtt');
const Zigbee = require('./zigbee');
const logger = require('./util/logger');
const deviceMapping = require('./devices');
const zigbee2mqtt = require('./converters/zigbee2mqtt');
const mqtt2zigbee = require('./converters/mqtt2zigbee');

class Controller {

    constructor() {
        this.zigbee = new Zigbee();
        this.mqtt = new MQTT();
        this.stateCache = {};

        this.handleZigbeeMessage = this.handleZigbeeMessage.bind(this);
        this.handleMQTTMessage = this.handleMQTTMessage.bind(this);
    }

    start() {
        this.zigbee.start(this.handleZigbeeMessage, (error) => {
            if (error) {
                logger.error('Failed to start');
            } else {
                this.mqtt.connect(this.handleMQTTMessage);
            }
        });
    }

    stop(callback) {
        this.mqtt.disconnect();
        this.zigbee.stop(callback);
    }

    handleZigbeeMessage(message) {
        if (!message.endpoints) {
            // We dont handle messages without endpoints.
            return;
        }

        const device = message.endpoints[0].device;

        // Check if this is a new device.
        if (!settings.get().devices[device.ieeeAddr]) {
            logger.info(`New device with address ${device.ieeeAddr} connected!`);

            settings.get().devices[device.ieeeAddr] = {
                friendly_name: device.ieeeAddr,
                retain: false,
            };

            settings.write();
        }

        // We can't handle devices without modelId.
        if (!device.modelId) {
            return;
        }

        // Map Zigbee modelID to vendor modelID.
        const modelID = msg.endpoints[0].device.modelId;
        const mappedModel = deviceMapping[modelID];

        if (!mappedModel) {
            logger.error(`Device with modelID '${modelID}' is not supported.`);
            logger.error('Please create an issue on https://github.com/Koenkk/zigbee2mqtt/issues to add support for your device');
            return;
        }

        // Find a conveter for this message.
        const cid = msg.data.cid;
        const converters = zigbee2mqtt.filter((c) => c.devices.includes(mappedModel.model) && c.cid === cid && c.type === msg.type);

        if (!converters.length) {
            logger.error(`No converter available for '${mappedModel.model}' with cid '${cid}' and type '${msg.type}'`);
            logger.error('Please create an issue on https://github.com/Koenkk/zigbee2mqtt/issues with this message.');
            return;
        }

        // Convert this Zigbee message to a MQTT message.
        const friendlyName = settings.get().devices[device.ieeeAddr].friendly_name;
        const retain = settings.get().devices[device.ieeeAddr].retain;
        const topic = `${settings.get().mqtt.base_topic}/${friendlyName}`;

        const publish = (payload) => {
            if (this.stateCache[device.ieeeAddr]) {
                payload = {...this.stateCache[device.ieeeAddr], ...payload};
            }

            this.mqtt.publish(topic, JSON.stringify(payload), retain);
        }

        // Get payload for the message.
        // - If a payload is returned publish it to the MQTT broker
        // - If NO payload is returned do nothing. This is for non-standard behaviour
        //   for e.g. click switches where we need to count number of clicks and detect long presses.
        converters.forEach((converter) => {
            const payload = converter.convert(msg, publish);

            if (payload) {
                this.stateCache[device.ieeeAddr] = {...this.stateCache[device.ieeeAddr], ...payload};

                if (!converter.disablePublish) {
                    publish(payload);
                }
            }
        });
    }

    handleMQTTMessage(topic, message) {
        const friendlyName = topic.split('/')[1];

        // Map friendlyName to deviceID.
        const deviceID = Object.keys(settings.get().devices).find((id) => settings.get().devices[id].friendly_name === friendlyName);
        if (!deviceID) {
            logger.error(`Cannot handle '${topic}' because deviceID of '${friendlyName}' cannot be found`);
        }

        // Convert the MQTT message to a Zigbee message.
        const json = JSON.parse(message);
        Object.keys(json).forEach((key) => {
            // Find converter for this key.
            const converter = mqtt2zigbee[key];
            if (!converter) {
                logger.error(`No converter available for '${key}' (${json[key]})`);
                return;
            }

            const message = converter(json[key]);
            const callback = (error, response) => {
                // Devices do not report when they go off, this ensures state (on/off) is always in sync.
                if (!error && key === 'state') {
                    this.mqtt.publish(friendlyName, JSON.stringify({state: json[key]}), true);
                }
            };

            this.zigbee.publish(deviceID, message.cId, message.cmd, message.zclData, callback);
        });
    }
}

module.exports = Controller;