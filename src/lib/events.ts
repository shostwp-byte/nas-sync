import { EventEmitter } from 'node:events';
import type { Server as SocketIOServer } from 'socket.io';
import type {
  ProgressEventPayload,
  SystemAlert,
  UpdateProgressEvent,
} from '@/types';

declare global {
  // eslint-disable-next-line no-var
  var __nasSyncEventBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __nasSyncIo: SocketIOServer | undefined;
}

export function getEventBus(): EventEmitter {
  if (!globalThis.__nasSyncEventBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    globalThis.__nasSyncEventBus = bus;
  }
  return globalThis.__nasSyncEventBus;
}

export function attachSocketIO(io: SocketIOServer) {
  globalThis.__nasSyncIo = io;
}

export function getSocketIO(): SocketIOServer | undefined {
  return globalThis.__nasSyncIo;
}

export function emitJobProgress(payload: ProgressEventPayload) {
  getEventBus().emit('job:progress', payload);
  globalThis.__nasSyncIo?.emit('job:progress', payload);
}

export function emitJobLog(data: {
  jobId: number;
  serverId: number;
  hostname: string;
  line: string;
  timestamp: string;
}) {
  getEventBus().emit('job:log', data);
  globalThis.__nasSyncIo?.emit('job:log', data);
}

export function emitJobUpdated(jobId: number) {
  getEventBus().emit('job:updated', { jobId });
  globalThis.__nasSyncIo?.emit('job:updated', { jobId });
}

export function emitVolumeUpdated() {
  getEventBus().emit('volume:updated', {});
  globalThis.__nasSyncIo?.emit('volume:updated', {});
}

export function emitNewAlert(alert: SystemAlert) {
  getEventBus().emit('alert:new', alert);
  globalThis.__nasSyncIo?.emit('alert:new', alert);
}

export function emitSystemUpdateProgress(payload: UpdateProgressEvent) {
  getEventBus().emit('system:update_progress', payload);
  globalThis.__nasSyncIo?.emit('system:update_progress', payload);
}
