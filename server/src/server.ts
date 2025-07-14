// server/sfu-server.ts

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import * as mediasoup from 'mediasoup';

// FIX: Import ALL types from this single, correct path.
import {
    Worker,
    Router,
    WebRtcTransport,
    Producer,
    Consumer,
    RtpCodecCapability
} from 'mediasoup/node/lib/types';


const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

const PORT = 4000;

let worker: Worker;
let router: Router;
let producer: Producer | undefined;
let producerTransport: WebRtcTransport | undefined;


const createWorker = async () => {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
    });
    worker.on('died', () => {
        console.error('mediasoup worker died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
    });
    const mediaCodecs: RtpCodecCapability[] = [
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
        { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
    ];
    router = await worker.createRouter({ mediaCodecs });
};

createWorker();

const consumerTransports = new Map<string, WebRtcTransport>();
const consumers = new Map<string, Consumer>();


io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log('user disconnected', socket.id);
        consumerTransports.get(socket.id)?.close();
        consumerTransports.delete(socket.id);
        consumers.get(socket.id)?.close();
        consumers.delete(socket.id);
    });

    socket.on('getRouterRtpCapabilities', (_, callback) => {
        if (!router) {
            return callback({error: 'Router not initialized'});
        }
        callback(router.rtpCapabilities);
    });

    // --- Producer Handlers ---

    socket.on('createProducerTransport', async (_, callback) => {
        try {
            const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
                enableUdp: true, enableTcp: true, preferUdp: true,
            });
            producerTransport = transport;
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            callback({ error: (error as Error).message });
        }
    });

    socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
        if (!producerTransport) return;
        await producerTransport.connect({ dtlsParameters });
        callback();
    });

    socket.on('produce', async ({ kind, rtpParameters }, callback) => {
        if (!producerTransport) return;
        producer = await producerTransport.produce({ kind, rtpParameters });
        callback({ id: producer.id });
        console.log('New producer created with id:', producer.id);
        socket.broadcast.emit('new-producer-available', { producerId: producer.id });
    });

    // --- Consumer Handlers ---

    socket.on('createConsumerTransport', async (_, callback) => {
        try {
            const transport = await router.createWebRtcTransport({
                listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
                enableUdp: true, enableTcp: true, preferUdp: true,
            });
            consumerTransports.set(socket.id, transport);
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            callback({ error: (error as Error).message });
        }
    });

    socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
        const transport = consumerTransports.get(socket.id);
        if (!transport) return;
        await transport.connect({ dtlsParameters });
        callback();
    });

    socket.on('consume', async ({ rtpCapabilities }, callback) => {
        // FIX: Add checks to ensure producer is not undefined before using it.
        if (!producer) {
            return callback({ error: 'No producer available' });
        }
        
        const transport = consumerTransports.get(socket.id);
        if (!transport) {
            return callback({ error: 'No consumer transport available for this socket' });
        }
        
        if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
            return callback({ error: 'Cannot consume' });
        }
        
        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true,
            });
            consumers.set(socket.id, consumer);

            callback({
                id: consumer.id,
                producerId: producer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            callback({ error: (error as Error).message });
        }
    });

    socket.on('resume', async () => {
        const consumer = consumers.get(socket.id);
        if (consumer) {
            await consumer.resume();
            console.log('Resumed consumer for', socket.id);
        }
    });
});

server.listen(PORT, () => {
    console.log(`SFU Server listening on port ${PORT}`);
});