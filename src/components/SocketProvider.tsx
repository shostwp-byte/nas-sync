'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ProgressEventPayload,
  SystemAlert,
  UpdateProgressEvent,
} from '@/types';

export interface LiveLogEntry {
  jobId: number;
  hostname: string;
  line: string;
  timestamp: string;
}

interface SocketContextValue {
  connected: boolean;
  progressMap: Record<number, ProgressEventPayload>;
  liveLogs: LiveLogEntry[];
  lastUpdateCounter: number;
  latestAlert: SystemAlert | null;
  updateProgress: UpdateProgressEvent | null;
  updateLogs: string[];
  clearLogs: () => void;
  clearUpdateLogs: () => void;
}

const SocketContext = createContext<SocketContextValue>({
  connected: false,
  progressMap: {},
  liveLogs: [],
  lastUpdateCounter: 0,
  latestAlert: null,
  updateProgress: null,
  updateLogs: [],
  clearLogs: () => {},
  clearUpdateLogs: () => {},
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [progressMap, setProgressMap] = useState<
    Record<number, ProgressEventPayload>
  >({});
  const [liveLogs, setLiveLogs] = useState<LiveLogEntry[]>([]);
  const [lastUpdateCounter, setLastUpdateCounter] = useState(0);
  const [latestAlert, setLatestAlert] = useState<SystemAlert | null>(null);
  const [updateProgress, setUpdateProgress] =
    useState<UpdateProgressEvent | null>(null);
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    // Server từ chối bắt tay khi chưa đăng nhập (VD: đang ở trang /login) — Socket.IO không tự
    // kết nối lại sau lỗi middleware, nên thử lại định kỳ để nhận cookie phiên sau khi đăng nhập.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    socket.on('connect_error', () => {
      if (socket.active || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        socket.connect();
      }, 3000);
    });

    socket.on('job:progress', (payload: ProgressEventPayload) => {
      setProgressMap((prev) => ({
        ...prev,
        [payload.jobId]: payload,
      }));
    });

    socket.on(
      'job:log',
      (entry: {
        jobId: number;
        hostname: string;
        line: string;
        timestamp: string;
      }) => {
        setLiveLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      }
    );

    socket.on('job:updated', () => {
      setLastUpdateCounter((c) => c + 1);
    });

    socket.on('volume:updated', () => {
      setLastUpdateCounter((c) => c + 1);
    });

    socket.on('alert:new', (alert: SystemAlert) => {
      setLatestAlert(alert);
      setLastUpdateCounter((c) => c + 1);
    });

    socket.on('system:update_progress', (payload: UpdateProgressEvent) => {
      setUpdateProgress(payload);
      if (payload.logLine) {
        setUpdateLogs((prev) => {
          const next = [...prev, payload.logLine!];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      }
    });

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      socket.disconnect();
    };
  }, []);

  return (
    <SocketContext.Provider
      value={{
        connected,
        progressMap,
        liveLogs,
        lastUpdateCounter,
        latestAlert,
        updateProgress,
        updateLogs,
        clearLogs: () => setLiveLogs([]),
        clearUpdateLogs: () => {
          setUpdateLogs([]);
          setUpdateProgress(null);
        },
      }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useRealtime() {
  return useContext(SocketContext);
}

