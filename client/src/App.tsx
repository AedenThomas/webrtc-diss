import React, { useEffect, useRef, useState, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';

const SIGNALING_SERVER_URL = 'http://localhost:4000';
const ROOM_ID = 'university-lecture-1';

function App() {
  const socket = useRef<Socket | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const isSharing = useRef(false);

  const [isButtonDisabled, setIsButtonDisabled] = useState(false);
  const [latency, setLatency] = useState(0);

  const presenterCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteVideosContainerRef = useRef<HTMLDivElement>(null);
  // THE FIX IS ON THIS LINE:
  const requestRef = useRef<number | undefined>(undefined);

  const createPeerConnection = useCallback((targetId: string): RTCPeerConnection => {
    console.log(`Creating peer connection for ${targetId}`);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.current?.emit('ice-candidate', { target: targetId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      console.log(`Track received from ${targetId}`);
      if (remoteVideosContainerRef.current) {
        const videoEl = document.createElement('video');
        videoEl.id = `video-${targetId}`;
        videoEl.srcObject = event.streams[0];
        videoEl.autoplay = true;
        videoEl.style.width = "320px";
        videoEl.style.margin = "5px";
        videoEl.style.border = "1px solid red";
        remoteVideosContainerRef.current.appendChild(videoEl);
      }
    };

    peerConnections.current[targetId] = pc;
    return pc;
  }, []);

  const handleOffer = useCallback(async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
    console.log(`Received an offer from ${payload.sender}`);
    const pc = createPeerConnection(payload.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.current?.emit('answer', { target: payload.sender, sdp: pc.localDescription });
  }, [createPeerConnection]);

  const handleAnswer = useCallback(async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
    console.log(`Received an answer from ${payload.sender}`);
    const pc = peerConnections.current[payload.sender];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  }, []);

  const handleIceCandidate = useCallback(async (payload: { candidate: RTCIceCandidateInit, sender: string }) => {
    const pc = peerConnections.current[payload.sender];
    if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  }, []);
  
  const createAndSendOffer = useCallback(async (userId: string, stream: MediaStream) => {
    const pc = createPeerConnection(userId);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.current?.emit('offer', { target: userId, sdp: pc.localDescription });
  }, [createPeerConnection]);
  
  useEffect(() => {
    socket.current = io(SIGNALING_SERVER_URL);

    const onUserJoined = (userId: string) => {
      if (isSharing.current && localStream.current) {
        createAndSendOffer(userId, localStream.current);
      }
    };

    const onUserLeft = (userId: string) => {
      peerConnections.current[userId]?.close();
      delete peerConnections.current[userId];
      const videoEl = document.getElementById(`video-${userId}`);
      if(videoEl) videoEl.remove();
    };

    const onPresenterDrewFrame = (timestamp: number) => {
      const currentLatency = Date.now() - timestamp;
      setLatency(currentLatency);
      (window as any).currentLatency = currentLatency;
    };
    
    socket.current.on('connect', () => {
      socket.current?.emit('join-room', ROOM_ID);
    });

    socket.current.on('user-joined', onUserJoined);
    socket.current.on('user-left', onUserLeft);
    socket.current.on('offer', handleOffer);
    socket.current.on('answer', handleAnswer);
    socket.current.on('ice-candidate', handleIceCandidate);
    socket.current.on('presenter-drew-frame', onPresenterDrewFrame);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      socket.current?.disconnect();
    };
  }, [createAndSendOffer, handleAnswer, handleIceCandidate, handleOffer]);

  const drawOnCanvas = () => {
    if (!presenterCanvasRef.current) return;
    const ctx = presenterCanvasRef.current.getContext('2d');
    if (!ctx) return;
    const frameCount = (requestRef.current || 0);
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = 'lightgreen';
    ctx.font = '24px monospace';
    ctx.fillText('// Automated Performance Test', 30, 50);
    ctx.fillText(`// Frame: ${frameCount}`, 30, 80);
    ctx.fillText(`const timestamp = ${Date.now()};`, 30, 110);
    socket.current?.emit('frame-drawn', Date.now());
    requestRef.current = requestAnimationFrame(drawOnCanvas);
  };
  
  const startScreenShare = async () => {
    setIsButtonDisabled(true);
    try {
      drawOnCanvas();
      if (!presenterCanvasRef.current) throw new Error("Presenter canvas not found");
      const stream = presenterCanvasRef.current.captureStream(30);
      localStream.current = stream;
      isSharing.current = true;
      socket.current?.emit('get-users', ROOM_ID, (users: string[]) => {
        users.forEach((userId) => createAndSendOffer(userId, stream));
      });
    } catch (err) {
      console.error('Error starting screen share:', err);
      setIsButtonDisabled(false);
    }
  };

  return (
    <div>
      <h1>P2P Automated Test Page</h1>
      <button id="start-share" onClick={startScreenShare} disabled={isButtonDisabled}>
        Start Sharing
      </button>
      <hr />
      <h3>Source (Presenter's Canvas)</h3>
      <canvas 
        ref={presenterCanvasRef} 
        width="640" 
        height="480" 
        style={{ border: '2px solid green', backgroundColor: '#333' }}
      ></canvas>
      <h3>Live Stats (from first viewer)</h3>
      <p>Glass-to-Glass Latency: <strong>{latency.toFixed(0)} ms</strong></p>
      <hr />
      <h3>Remote Streams (Viewer's Output)</h3>
      <div 
        ref={remoteVideosContainerRef}
        style={{ display: 'flex', flexWrap: 'wrap' }}
      ></div>
    </div>
  );
}

export default App;