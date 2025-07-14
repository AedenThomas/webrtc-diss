// client/src/SfuApp.tsx
import React, { useEffect, useRef } from "react";
import io, { Socket } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

const SIGNALING_SERVER_URL = "http://localhost:4000";

function SfuApp() {
  // FIX: Provide `null` or `undefined` as initial values for all refs.
  const socket = useRef<Socket | null>(null);
  const device = useRef<mediasoupClient.Device | undefined>(undefined);
  const producerTransport = useRef<mediasoupClient.types.Transport | undefined>(
    undefined
  );
  const consumerTransport = useRef<mediasoupClient.types.Transport | undefined>(
    undefined
  );
  const producer = useRef<mediasoupClient.types.Producer | undefined>(
    undefined
  );

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    socket.current = io(SIGNALING_SERVER_URL);
    return () => {
      socket.current?.disconnect();
    };
  }, []);

  const goLive = async () => {
    if (!socket.current) return;
    socket.current.emit(
      "getRouterRtpCapabilities",
      async (routerRtpCapabilities: any) => {
        device.current = new mediasoupClient.Device();
        await device.current.load({ routerRtpCapabilities });

        if (!socket.current || !device.current) return;
        socket.current.emit(
          "createProducerTransport",
          {},
          async (params: any) => {
            if (params.error) {
              console.error(params.error);
              return;
            }

            if (!device.current) return;
            producerTransport.current =
              device.current.createSendTransport(params);

            producerTransport.current.on(
              "connect",
              async ({ dtlsParameters }, callback, errback) => {
                socket.current?.emit(
                  "connectProducerTransport",
                  { dtlsParameters },
                  () => {
                    callback();
                  }
                );
              }
            );

            producerTransport.current.on(
              "produce",
              async ({ kind, rtpParameters, appData }, callback, errback) => {
                try {
                  socket.current?.emit(
                    "produce",
                    { kind, rtpParameters },
                    ({ id }: { id: string }) => {
                      callback({ id });
                    }
                  );
                } catch (err) {
                  errback(err as Error);
                }
              }
            );

            try {
              const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
              });
              if (localVideoRef.current)
                localVideoRef.current.srcObject = stream;
              const track = stream.getVideoTracks()[0];
              if (!producerTransport.current) return;
              producer.current = await producerTransport.current.produce({
                track,
              });
            } catch (err) {
              console.error(err);
            }
          }
        );
      }
    );
  };

  const goWatch = async () => {
    if (!socket.current) return;
    socket.current.emit(
      "getRouterRtpCapabilities",
      async (routerRtpCapabilities: any) => {
        device.current = new mediasoupClient.Device();
        await device.current.load({ routerRtpCapabilities });

        if (!socket.current || !device.current) return;
        socket.current.emit(
          "createConsumerTransport",
          {},
          async (params: any) => {
            if (params.error) {
              console.error(params.error);
              return;
            }

            if (!device.current) return;
            consumerTransport.current =
              device.current.createRecvTransport(params);

            consumerTransport.current.on(
              "connect",
              async ({ dtlsParameters }, callback, errback) => {
                socket.current?.emit(
                  "connectConsumerTransport",
                  { dtlsParameters },
                  () => {
                    callback();
                  }
                );
              }
            );

            if (!socket.current || !consumerTransport.current) return;
            socket.current.emit("consume", {}, async (consumerParams: any) => {
              if (consumerParams.error) {
                console.error(consumerParams.error);
                return;
              }

              if (!consumerTransport.current) return;
              const consumer = await consumerTransport.current.consume(
                consumerParams
              );
              const { track } = consumer;
              const stream = new MediaStream([track]);
              if (remoteVideoRef.current)
                remoteVideoRef.current.srcObject = stream;

              socket.current?.emit("resume");
            });
          }
        );
      }
    );
  };

  return (
    <div>
      <h1>SFU WebRTC Screen Share</h1>
      <button id="go-live-button" onClick={goLive}>
        Go Live (Presenter)
      </button>
      <button id="watch-button" onClick={goWatch}>
        Watch Stream (Viewer)
      </button>
      <h2>My Screen</h2>
      <video ref={localVideoRef} autoPlay muted style={{ width: 320 }}></video>
      <h2>Remote Screen</h2>
      <video ref={remoteVideoRef} autoPlay style={{ width: 320 }}></video>
    </div>
  );
}

export default SfuApp;
