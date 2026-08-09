"use client";

import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/** Client-side singleton so multiple components share one realtime connection. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/api/socket.io",
      withCredentials: true,
      autoConnect: true,
    });
  }
  return socket;
}
