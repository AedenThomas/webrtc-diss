// server/src/server.ts
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 4000;

// Data structures for tracking rooms
const rooms: Record<string, string[]> = {};
const socketToRoom: Record<string, string> = {};

io.on("connection", (socket) => {
  console.log(`A user connected: ${socket.id}`);

  socket.on("frame-drawn", (timestamp) => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      socket.to(roomId).emit('presenter-drew-frame', timestamp);
    }
  });

  socket.on("join-room", (roomId: string) => {
    socket.join(roomId);
    socketToRoom[socket.id] = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }

    // Inform the new user about existing users (for the presenter to call)
    const otherUsers = rooms[roomId];
    socket.emit("existing-users", otherUsers);

    // Add current user to the room list
    rooms[roomId].push(socket.id);

    // Inform existing users about the new user
    socket.to(roomId).emit("user-joined", socket.id);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on("offer", (payload) => {
    io.to(payload.target).emit("offer", {
      sdp: payload.sdp,
      sender: socket.id,
    });
  });

  socket.on("answer", (payload) => {
    io.to(payload.target).emit("answer", {
      sdp: payload.sdp,
      sender: socket.id,
    });
  });

  socket.on("ice-candidate", (payload) => {
    io.to(payload.target).emit("ice-candidate", {
      candidate: payload.candidate,
      sender: socket.id,
    });
  });

  // This was missing from the previous client code but is good practice
  socket.on("get-users", (roomId: string, callback) => {
    const usersInRoom = rooms[roomId]?.filter((id) => id !== socket.id) || [];
    callback(usersInRoom);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      socket.to(roomId).emit("user-left", socket.id);
    }
    delete socketToRoom[socket.id];
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
