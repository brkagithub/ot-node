import appRootPath from 'app-root-path';
import libp2p from 'libp2p';
import KadDHT from 'libp2p-kad-dht';
import { join } from 'path';
import Bootstrap, { tag } from 'libp2p-bootstrap';
import { NOISE } from 'libp2p-noise';
import MPLEX from 'libp2p-mplex';
import TCP from 'libp2p-tcp';
import pipe from 'it-pipe';
import map from 'it-map';
import { encode, decode } from 'it-length-prefixed';
import { create as _create, createFromPrivKey, createFromB58String } from 'peer-id';
import { InMemoryRateLimiter } from 'rolling-rate-limiter';
import toobusy from 'toobusy-js';
import { v5 as uuidv5 } from 'uuid';
import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import ip from 'ip';
import { TimeoutController } from 'timeout-abort-controller';
import {
    NETWORK_API_RATE_LIMIT,
    NETWORK_API_SPAM_DETECTION,
    NETWORK_MESSAGE_TYPES,
    NETWORK_API_BLACK_LIST_TIME_WINDOW_MINUTES,
    LIBP2P_KEY_DIRECTORY,
    LIBP2P_KEY_FILENAME,
    NODE_ENVIRONMENTS,
    BYTES_IN_MEGABYTE,
} from '../../../constants/constants.js';

const devEnvironment =
    process.env.NODE_ENV === NODE_ENVIRONMENTS.DEVELOPMENT ||
    process.env.NODE_ENV === NODE_ENVIRONMENTS.TEST;

const initializationObject = {
    addresses: {
        listen: ['/ip4/0.0.0.0/tcp/9000'],
    },
    modules: {
        transport: [TCP],
        streamMuxer: [MPLEX],
        connEncryption: [NOISE],
        dht: KadDHT,
    },
};

class Libp2pService {
    async initialize(config, logger) {
        this.config = config;
        this.logger = logger;

        initializationObject.peerRouting = this.config.peerRouting;
        initializationObject.config = {
            dht: {
                enabled: true,
                ...this.config.dht,
            },
        };
        initializationObject.dialer = this.config.connectionManager;

        if (this.config.bootstrap.length > 0) {
            initializationObject.modules.peerDiscovery = [Bootstrap];
            initializationObject.config.peerDiscovery = {
                autoDial: true,
                [tag]: {
                    enabled: true,
                    list: this.config.bootstrap,
                },
            };
        }
        initializationObject.addresses = {
            listen: [`/ip4/0.0.0.0/tcp/${this.config.port}`], // for production
            // announce: ['/dns4/auto-relay.libp2p.io/tcp/443/wss/p2p/QmWDn2LY8nannvSWJzruUYoLZ4vV83vfCBwd8DipvdgQc3']
        };
        let id;
        if (!this.config.peerId) {
            if (!devEnvironment || !this.config.privateKey) {
                this.config.privateKey = await this.readPrivateKeyFromFile();
            }

            if (!this.config.privateKey) {
                id = await _create({ bits: 1024, keyType: 'RSA' });
                this.config.privateKey = id.toJSON().privKey;
                await this.savePrivateKeyInFile(this.config.privateKey);
            } else {
                id = await createFromPrivKey(this.config.privateKey);
            }
            this.config.peerId = id;
        }

        initializationObject.peerId = this.config.peerId;
        this._initializeRateLimiters();
        /**
         * sessions = {
         *     [peerId]: {
         *         [operationId]: {
         *             [keywordUuid] : {
         *                  stream
         *              }
         *         }
         *     }
         * }
         */
        this.sessions = {};
        this.node = await libp2p.create(initializationObject);
        await this.node.start();
        const port = parseInt(this.node.multiaddrs.toString().split('/')[4], 10);
        const peerId = this.node.peerId.toB58String();
        this.config.id = peerId;
        this.logger.info(`Network ID is ${peerId}, connection port is ${port}`);
    }

    async onPeerConnected(listener) {
        this.node.connectionManager.on('peer:connect', listener);
    }

    async savePrivateKeyInFile(privateKey) {
        const { fullPath, directoryPath } = this.getKeyPath();
        await mkdir(directoryPath, { recursive: true });
        await writeFile(fullPath, privateKey);
    }

    getKeyPath() {
        let directoryPath;
        if (process.env.NODE_ENV === 'testnet' || process.env.NODE_ENV === 'mainnet') {
            directoryPath = join(
                appRootPath.path,
                '..',
                this.config.appDataPath,
                LIBP2P_KEY_DIRECTORY,
            );
        } else {
            directoryPath = join(appRootPath.path, this.config.appDataPath, LIBP2P_KEY_DIRECTORY);
        }

        const fullPath = join(directoryPath, LIBP2P_KEY_FILENAME);
        return { fullPath, directoryPath };
    }

    async readPrivateKeyFromFile() {
        const keyPath = this.getKeyPath();
        if (await this.fileExists(keyPath.fullPath)) {
            const key = (await readFile(keyPath.fullPath)).toString();
            return key;
        }
    }

    async fileExists(filePath) {
        try {
            await stat(filePath);
            return true;
        } catch (e) {
            return false;
        }
    }

    _initializeRateLimiters() {
        const basicRateLimiter = new InMemoryRateLimiter({
            interval: NETWORK_API_RATE_LIMIT.TIME_WINDOW_MILLS,
            maxInInterval: NETWORK_API_RATE_LIMIT.MAX_NUMBER,
        });

        const spamDetection = new InMemoryRateLimiter({
            interval: NETWORK_API_SPAM_DETECTION.TIME_WINDOW_MILLS,
            maxInInterval: NETWORK_API_SPAM_DETECTION.MAX_NUMBER,
        });

        this.rateLimiter = {
            basicRateLimiter,
            spamDetection,
        };

        this.blackList = {};
    }

    getMultiaddrs() {
        return this.node.multiaddrs;
    }

    getProtocols(peerId) {
        return this.node.peerStore.protoBook.get(peerId);
    }

    getAddresses(peerId) {
        return this.node.peerStore.addressBook.get(peerId);
    }

    getPeers() {
        return this.node.connectionManager.connections;
    }

    getPeerId() {
        return this.node.peerId;
    }

    handleMessage(protocol, handler) {
        this.logger.info(`Enabling network protocol: ${protocol}`);

        this.node.handle(protocol, async (handlerProps) => {
            const { stream } = handlerProps;
            const remotePeerId = handlerProps.connection.remotePeer.toB58String();
            const { message, valid, busy } = await this._readMessageFromStream(
                stream,
                this.isRequestValid.bind(this),
                remotePeerId,
            );

            this.updateSessionStream(
                message.header.operationId,
                message.header.keywordUuid,
                remotePeerId,
                stream,
            );

            if (!valid) {
                await this.sendMessageResponse(
                    protocol,
                    remotePeerId,
                    NETWORK_MESSAGE_TYPES.RESPONSES.NACK,
                    message.header.operationId,
                    message.header.keywordUuid,
                    { errorMessage: 'Invalid request message' },
                );
            } else if (busy) {
                await this.sendMessageResponse(
                    protocol,
                    remotePeerId,
                    NETWORK_MESSAGE_TYPES.RESPONSES.BUSY,
                    message.header.operationId,
                    message.header.keywordUuid,
                    {},
                );
            } else {
                this.logger.debug(
                    `Receiving message from ${remotePeerId} to ${this.config.id}: protocol: ${protocol}, messageType: ${message.header.messageType};`,
                );
                await handler(message, remotePeerId);
            }
        });
    }

    updateSessionStream(operationId, keywordUuid, remotePeerId, stream) {
        this.logger.trace(
            `Storing new session stream for remotePeerId: ${remotePeerId} with operation id: ${operationId}`,
        );
        if (!this.sessions[remotePeerId]) {
            this.sessions[remotePeerId] = {
                [operationId]: {
                    [keywordUuid]: {
                        stream,
                    },
                },
            };
        } else if (!this.sessions[remotePeerId][operationId]) {
            this.sessions[remotePeerId][operationId] = {
                [keywordUuid]: {
                    stream,
                },
            };
        } else {
            this.sessions[remotePeerId][operationId][keywordUuid] = {
                stream,
            };
        }
    }

    getSessionStream(operationId, keywordUuid, remotePeerId) {
        if (
            this.sessions[remotePeerId] &&
            this.sessions[remotePeerId][operationId] &&
            this.sessions[remotePeerId][operationId][keywordUuid]
        ) {
            this.logger.trace(
                `Session found remotePeerId: ${remotePeerId}, operation id: ${operationId}`,
            );
            return this.sessions[remotePeerId][operationId][keywordUuid].stream;
        }
        return null;
    }

    createStreamMessage(message, operationId, keywordUuid, messageType) {
        return {
            header: {
                messageType,
                operationId,
                keywordUuid,
            },
            data: message,
        };
    }

    async sendMessage(protocol, peerId, messageType, operationId, keyword, message, timeout) {
        const nackMessage = {
            header: { messageType: NETWORK_MESSAGE_TYPES.RESPONSES.NACK },
            data: {
                errorMessage: '',
            },
        };
        const keywordUuid = uuidv5(keyword, uuidv5.URL);

        // const sessionStream = this.getSessionStream(operationId, remotePeerId.toB58String());
        // if (!sessionStream) {
        // } else {
        //     stream = sessionStream;
        // }

        const remotePeerId = createFromB58String(peerId);

        const publicIp = (this.getAddresses(remotePeerId) ?? [])
            .map((addr) => addr.multiaddr)
            .filter((addr) => addr.isThinWaistAddress())
            .map((addr) => addr.toString().split('/'))
            .filter((splittedAddr) => !ip.isPrivate(splittedAddr[2]))[0]?.[2];

        this.logger.trace(
            `Dialing remotePeerId: ${remotePeerId.toB58String()} with public ip: ${publicIp}: protocol: ${protocol}, messageType: ${messageType} , operationId: ${operationId}`,
        );
        let dialResult;
        let dialStart;
        let dialEnd;
        try {
            dialStart = Date.now();
            dialResult = await this.node.dialProtocol(remotePeerId, protocol);
            dialEnd = Date.now();
        } catch (error) {
            dialEnd = Date.now();
            nackMessage.data.errorMessage = `Unable to dial peer: ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${messageType} , operationId: ${operationId}, dial execution time: ${
                dialEnd - dialStart
            } ms. Error: ${error.message}`;

            return nackMessage;
        }
        this.logger.trace(
            `Created stream for peer: ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${messageType} , operationId: ${operationId}, dial execution time: ${
                dialEnd - dialStart
            } ms.`,
        );
        const { stream } = dialResult;

        this.updateSessionStream(operationId, keywordUuid, remotePeerId.toB58String(), stream);

        const streamMessage = this.createStreamMessage(
            message,
            operationId,
            keywordUuid,
            messageType,
        );

        this.logger.trace(
            `Sending message to ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${messageType}, operationId: ${operationId}`,
        );

        let sendMessageStart;
        let sendMessageEnd;
        try {
            sendMessageStart = Date.now();
            await this._sendMessageToStream(stream, streamMessage);
            sendMessageEnd = Date.now();
        } catch (error) {
            sendMessageEnd = Date.now();
            nackMessage.data.errorMessage = `Unable to send message to peer: ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${messageType}, operationId: ${operationId}, execution time: ${
                sendMessageEnd - sendMessageStart
            } ms. Error: ${error.message}`;

            return nackMessage;
        }

        // if (!this.sessions[remotePeerId.toB58String()]) {
        //     this.sessions[remotePeerId.toB58String()] = {
        //         [operationId]: {
        //             stream
        //         }
        //     }
        // } else {
        //     this.sessions[remotePeerId.toB58String()][operationId] = {
        //             stream
        //     }
        // }
        // if (!this.sessions.sender[message.header.sessionId]) {
        //     this.sessions.sender[message.header.sessionId] = {};
        // }
        let readResponseStart;
        let readResponseEnd;
        let response;
        const timeoutController = new TimeoutController(timeout);
        try {
            readResponseStart = Date.now();

            timeoutController.signal.addEventListener(
                'abort',
                async () => {
                    stream.abort();
                    response = null;
                },
                { once: true },
            );

            response = await this._readMessageFromStream(
                stream,
                this.isResponseValid.bind(this),
                remotePeerId.toB58String(),
            );

            if (timeoutController.signal.aborted) {
                throw Error('Message timed out!');
            }

            timeoutController.signal.removeEventListener('abort');
            timeoutController.clear();

            readResponseEnd = Date.now();
        } catch (error) {
            timeoutController.signal.removeEventListener('abort');
            timeoutController.clear();

            readResponseEnd = Date.now();
            nackMessage.data.errorMessage = `Unable to read response from peer ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${messageType} , operationId: ${operationId}, execution time: ${
                readResponseEnd - readResponseStart
            } ms. Error: ${error.message}`;

            return nackMessage;
        }

        this.logger.trace(
            `Receiving response from ${remotePeerId.toB58String()}. protocol: ${protocol}, messageType: ${
                response.message?.header?.messageType
            }, operationId: ${operationId}, execution time: ${
                readResponseEnd - readResponseStart
            } ms.`,
        );

        if (!response.valid) {
            nackMessage.data.errorMessage = 'Invalid response';

            return nackMessage;
        }

        return response.message;
    }

    async sendMessageResponse(
        protocol,
        remotePeerId,
        messageType,
        operationId,
        keywordUuid,
        message,
    ) {
        this.logger.debug(
            `Sending response from ${this.config.id} to ${remotePeerId}: protocol: ${protocol}, messageType: ${messageType};`,
        );
        const stream = this.getSessionStream(operationId, keywordUuid, remotePeerId);

        if (!stream) {
            throw Error(`Unable to find opened stream for remotePeerId: ${remotePeerId}`);
        }

        const response = this.createStreamMessage(message, operationId, keywordUuid, messageType);

        await this._sendMessageToStream(stream, response);
    }

    // updateReceiverSession(header) {
    //     // if BUSY we expect same request, so don't update session
    //     if (header.messageType === constants.NETWORK_MESSAGE_TYPES.RESPONSES.BUSY) return;
    //     // if NACK we don't expect other requests, so delete session
    //     if (header.messageType === constants.NETWORK_MESSAGE_TYPES.RESPONSES.NACK) {
    //         if (header.sessionId) delete this.sessions.receiver[header.sessionId];
    //         return;
    //     }
    //
    //     // if session is new, initialise array of expected message types
    //     if (!this.sessions.receiver[header.sessionId].expectedMessageTypes) {
    //         this.sessions.receiver[header.sessionId].expectedMessageTypes = Object.keys(
    //             constants.NETWORK_MESSAGE_TYPES.REQUESTS,
    //         );
    //     }
    //
    //     // subroutine completed
    //     if (header.messageType === constants.NETWORK_MESSAGE_TYPES.RESPONSES.ACK) {
    //         // protocol operation completed, delete session
    //         if (this.sessions.receiver[header.sessionId].expectedMessageTypes.length <= 1) {
    //             this.removeSession(header.sessionId);
    //         } else {
    //             // operation not completed, update array of expected message types
    //             this.sessions.receiver[header.sessionId].expectedMessageTypes =
    //                 this.sessions.receiver[header.sessionId].expectedMessageTypes.slice(1);
    //         }
    //     }
    // }

    async _sendMessageToStream(stream, message) {
        const stringifiedHeader = JSON.stringify(message.header);
        const stringifiedData = JSON.stringify(message.data);

        const chunks = [stringifiedHeader];
        const chunkSize = BYTES_IN_MEGABYTE; // 1 MB

        // split data into 1 MB chunks
        for (let i = 0; i < stringifiedData.length; i += chunkSize) {
            chunks.push(stringifiedData.slice(i, i + chunkSize));
        }

        await pipe(
            chunks,
            // turn strings into buffers
            (source) => map(source, (string) => Buffer.from(string)),
            // Encode with length prefix (so receiving side knows how much data is coming)
            encode(),
            // Write to the stream (the sink)
            stream.sink,
        );
    }

    async _readMessageFromStream(stream, isMessageValid, remotePeerId) {
        return pipe(
            // Read from the stream (the source)
            stream.source,
            // Decode length-prefixed data
            decode(),
            // Turn buffers into strings
            (source) => map(source, (buf) => buf.toString()),
            // Sink function
            (source) => this.readMessageSink(source, isMessageValid, remotePeerId),
        );
    }

    async readMessageSink(source, isMessageValid, remotePeerId) {
        const message = { header: { operationId: '', keywordUuid: '' }, data: {} };
        // we expect first buffer to be header
        const stringifiedHeader = (await source.next()).value;

        if (!stringifiedHeader?.length) {
            return { message, valid: false, busy: false };
        }

        message.header = JSON.parse(stringifiedHeader);

        // validate request / response
        if (!(await isMessageValid(message.header, remotePeerId))) {
            return { message, valid: false };
        }

        // business check if PROTOCOL_INIT message
        if (
            message.header.messageType === NETWORK_MESSAGE_TYPES.REQUESTS.PROTOCOL_INIT &&
            this.isBusy()
        ) {
            return { message, valid: true, busy: true };
        }

        let stringifiedData = '';
        // read data the data
        for await (const chunk of source) {
            stringifiedData += chunk;
        }
        message.data = JSON.parse(stringifiedData);

        return { message, valid: true, busy: false };
    }

    async isRequestValid(header, remotePeerId) {
        // filter spam requests
        if (await this.limitRequest(header, remotePeerId)) return false;

        // header well formed
        if (
            !header.operationId ||
            !header.keywordUuid ||
            !header.messageType ||
            !Object.keys(NETWORK_MESSAGE_TYPES.REQUESTS).includes(header.messageType)
        )
            return false;
        if (header.messageType === NETWORK_MESSAGE_TYPES.REQUESTS.PROTOCOL_INIT) {
            return true;
        }

        return this.sessionExists(remotePeerId, header.operationId, header.keywordUuid);
    }

    sessionExists() {
        return true;
        // return this.sessions[remotePeerId.toB58String()] && this.sessions[remotePeerId.toB58String()][operationId];
    }

    async isResponseValid() {
        return true;
        // return (
        //     header.operationId &&
        //     header.messageType &&
        //     this.sessions[remotePeerId][header.operationId] &&
        //     Object.keys(constants.NETWORK_MESSAGE_TYPES.RESPONSES).includes(header.messageType)
        // );
    }

    removeSession(sessionId) {
        if (this.sessions.sender[sessionId]) {
            delete this.sessions.sender[sessionId];
        } else if (this.sessions.receiver[sessionId]) {
            delete this.sessions.receiver[sessionId];
        }
    }

    healthCheck() {
        // TODO: broadcast ping or sent msg to yourself
        const connectedNodes = this.node.connectionManager.size;
        if (connectedNodes > 0) return true;
        return false;
    }

    async limitRequest(header, remotePeerId) {
        // if (header.sessionId && this.sessions.receiver[header.sessionId]) return false;

        if (this.blackList[remotePeerId]) {
            const remainingMinutes = Math.floor(
                NETWORK_API_BLACK_LIST_TIME_WINDOW_MINUTES -
                    (Date.now() - this.blackList[remotePeerId]) / (1000 * 60),
            );

            if (remainingMinutes > 0) {
                this.logger.debug(
                    `Blocking request from ${remotePeerId}. Node is blacklisted for ${remainingMinutes} minutes.`,
                );

                return true;
            }
            delete this.blackList[remotePeerId];
        }

        if (await this.rateLimiter.spamDetection.limit(remotePeerId)) {
            this.blackList[remotePeerId] = Date.now();
            this.logger.debug(
                `Blocking request from ${remotePeerId}. Spammer detected and blacklisted for ${NETWORK_API_BLACK_LIST_TIME_WINDOW_MINUTES} minutes.`,
            );

            return true;
        }
        if (await this.rateLimiter.basicRateLimiter.limit(remotePeerId)) {
            this.logger.debug(
                `Blocking request from ${remotePeerId}. Max number of requests exceeded.`,
            );

            return true;
        }

        return false;
    }

    isBusy() {
        const distinctOperations = new Set();
        for (const peerId in this.sessions) {
            for (const operationId in Object.keys(this.sessions[peerId])) {
                distinctOperations.add(operationId);
            }
        }
        return toobusy(); // || distinctOperations.size > constants.MAX_OPEN_SESSIONS;
    }

    getPrivateKey() {
        return this.config.privateKey;
    }

    getName() {
        return 'Libp2p';
    }

    async findPeer(peerId) {
        return this.node.peerRouting.findPeer(createFromB58String(peerId));
    }

    async dial(peerId) {
        return this.node.dial(createFromB58String(peerId));
    }

    async getPeerInfo(peerId) {
        return this.node.peerStore.get(createFromB58String(peerId));
    }
}

export default Libp2pService;
