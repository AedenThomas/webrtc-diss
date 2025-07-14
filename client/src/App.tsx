import React, { useEffect, useRef, useState, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';

const SIGNALING_SERVER_URL = 'http://localhost:4000';
const ROOM_ID = 'university-lecture-1';

// Expose flags for Puppeteer to check
declare global {
    interface Window {
        isSharing: boolean;
        currentLatency: number;
    }
}

function App() {
  const socket = useRef<Socket | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  
  const [isButtonDisabled, setIsButtonDisabled] = useState(false);
  const [latency, setLatency] = useState(0);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideosContainerRef = useRef<HTMLDivElement>(null);
  
  const createPeerConnection = useCallback((targetId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.onicecandidate = (event) => {
      if (event.candidate) socket.current?.emit('ice-candidate', { target: targetId, candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      if (remoteVideosContainerRef.current) {
        const videoEl = document.createElement('video');
        videoEl.id = `video-${targetId}`;
        videoEl.srcObject = event.streams[0];
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.style.width = "320px";
        videoEl.style.border = "1px solid red";
        remoteVideosContainerRef.current.appendChild(videoEl);
      }
    };
    peerConnections.current[targetId] = pc;
    return pc;
  }, []);

  const createAndSendOffer = useCallback(async (userId: string, stream: MediaStream) => {
    const pc = createPeerConnection(userId);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.current?.emit('offer', { target: userId, sdp: pc.localDescription });
  }, [createPeerConnection]);

  useEffect(() => {
    const handleOffer = async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
      const pc = createPeerConnection(payload.sender);
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.current?.emit('answer', { target: payload.sender, sdp: pc.localDescription });
    };

    const handleAnswer = async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
      const pc = peerConnections.current[payload.sender];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    };

    const handleIceCandidate = async (payload: { candidate: RTCIceCandidateInit, sender: string }) => {
      const pc = peerConnections.current[payload.sender];
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    };

    const onUserJoined = (userId: string) => {
      if (window.isSharing && localStream.current) {
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
      window.currentLatency = currentLatency;
    };
    
    socket.current = io(SIGNALING_SERVER_URL);
    socket.current.on('connect', () => socket.current?.emit('join-room', ROOM_ID));
    socket.current.on('user-joined', onUserJoined);
    socket.current.on('user-left', onUserLeft);
    socket.current.on('offer', handleOffer);
    socket.current.on('answer', handleAnswer);
    socket.current.on('ice-candidate', handleIceCandidate);
    socket.current.on('presenter-drew-frame', onPresenterDrewFrame);

    return () => { socket.current?.disconnect(); };
  }, [createPeerConnection, createAndSendOffer]);

  const startScreenShare = async () => {
    console.log("startScreenShare called");
    setIsButtonDisabled(true);
    try {
      // The fake UI flags will make this resolve automatically with a test stream
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      
      console.log("getDisplayMedia success");
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      localStream.current = stream;
      window.isSharing = true; // Set the global flag for Puppeteer

      // Emit a fake 'drew-frame' event to sync latency calculation
      setInterval(() => {
        socket.current?.emit('frame-drawn', Date.now());
      }, 500);

      socket.current?.emit('get-users', ROOM_ID, (users: string[]) => {
        console.log("Got existing users:", users);
        users.forEach((userId) => createAndSendOffer(userId, stream));
      });
    } catch (err) {
      console.error('Error starting screen share:', err);
      window.isSharing = false;
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
      <h3>Source (Local Fake Stream)</h3>
      <video ref={localVideoRef} autoPlay muted playsInline style={{width: "320px", border: "2px solid green"}}></video>
      
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
