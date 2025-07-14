// client/src/App.tsx
import React, { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';

const SIGNALING_SERVER_URL = 'http://localhost:4000';
const ROOM_ID = 'university-lecture-1';

function App() {
  const socket = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const localStream = useRef<MediaStream | undefined>(undefined);
  const isSharing = useRef(false); // Use a ref for the flag to avoid stale closures

  const [isButtonDisabled, setIsButtonDisabled] = useState(false); // For UI feedback
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const addRemoteStream = (id: string, stream: MediaStream) => {
    setRemoteStreams((prev) => ({ ...prev, [id]: stream }));
  };

  const removeRemoteStream = (id: string) => {
    setRemoteStreams((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  useEffect(() => {
    socket.current = io(SIGNALING_SERVER_URL);

    // Set up all listeners once on component mount
    const setupListeners = () => {
      if (!socket.current) return;

      socket.current.on('connect', () => {
        console.log('Connected to signaling server');
        socket.current?.emit('join-room', ROOM_ID);
      });

      socket.current.on('user-joined', (userId: string) => {
        console.log(`A new user joined: ${userId}`);
        if (isSharing.current && localStream.current) {
          console.log(`I am the presenter, sending an offer to ${userId}`);
          createAndSendOffer(userId, localStream.current);
        }
      });

      socket.current.on('user-left', (userId: string) => {
        console.log(`User ${userId} left`);
        peerConnections.current[userId]?.close();
        delete peerConnections.current[userId];
        removeRemoteStream(userId);
      });

      socket.current.on('offer', handleOffer);
      socket.current.on('answer', handleAnswer);
      socket.current.on('ice-candidate', handleIceCandidate);
    };
    
    setupListeners();

    return () => {
      socket.current?.disconnect();
    };
  }, []);

  const createPeerConnection = (targetId: string): RTCPeerConnection => {
    console.log(`Creating peer connection for ${targetId}`);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.current?.emit('ice-candidate', {
          target: targetId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log(`Track received from ${targetId}`);
      addRemoteStream(targetId, event.streams[0]);
    };

    peerConnections.current[targetId] = pc;
    return pc;
  };

  const createAndSendOffer = async (userId: string, stream: MediaStream) => {
    const pc = createPeerConnection(userId);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.current?.emit('offer', { target: userId, sdp: pc.localDescription });
  };
  
  const startScreenShare = async () => {
    setIsButtonDisabled(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      localStream.current = stream;
      isSharing.current = true;

      // Ask the server for users who are already in the room
      socket.current?.emit('get-users', ROOM_ID, (users: string[]) => {
        console.log('Got existing users to send offers to:', users);
        users.forEach((userId) => createAndSendOffer(userId, stream));
      });

    } catch (err) {
      console.error('Error starting screen share:', err);
      setIsButtonDisabled(false);
    }
  };

  // VIEWER receives an offer from PRESENTER
  const handleOffer = async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
    console.log(`Received an offer from ${payload.sender}`);
    const pc = createPeerConnection(payload.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.current?.emit('answer', {
      target: payload.sender,
      sdp: pc.localDescription,
    });
  };

  // PRESENTER receives an answer from VIEWER
  const handleAnswer = async (payload: { sdp: RTCSessionDescriptionInit, sender: string }) => {
    console.log(`Received an answer from ${payload.sender}`);
    const pc = peerConnections.current[payload.sender];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    }
  };

  const handleIceCandidate = async (payload: { candidate: RTCIceCandidateInit, sender: string }) => {
    const pc = peerConnections.current[payload.sender];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    }
  };

  return (
    <div>
      <h1>P2P WebRTC Screen Share</h1>
      <button onClick={startScreenShare} disabled={isButtonDisabled}>
        Start Sharing
      </button>
      <h2>My Screen</h2>
      <video ref={localVideoRef} autoPlay muted style={{ width: 320 }}></video>
      <h2>Remote Screens</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {Object.entries(remoteStreams).map(([id, stream]) => (
          <video
            key={id}
            autoPlay
            ref={(el) => { if (el) el.srcObject = stream; }}
            style={{ width: 320, margin: 5, border: '1px solid black' }}
          />
        ))}
      </div>
    </div>
  );
}

export default App;