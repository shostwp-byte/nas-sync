import { EventEmitter } from 'node:events';
import type { Server as SocketIOServer } from 'socket.io';
import type {
  ProgressEventPayload,
  SystemAlert,
  UpdateProgressEvent,
} from '@/types';

declare global {
  // eslint-disable-next-line no-var
  var __shostEventBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __shostIo: SocketIOServer | undefined;
}

export function getEventBus(): EventEmitter {
  if (!globalThis.__shostEventBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    globalThis.__shostEventBus = bus;
  }
  return globalThis.__shostEventBus;
}

export function attachSocketIO(io: SocketIOServer) {
  globalThis.__shostIo = io;
}

export function getSocketIO(): SocketIOServer | undefined {
  return globalThis.__shostIo;
}

export function emitJobProgress(payload: ProgressEventPayload) {
  getEventBus().emit('job:progress', payload);
  globalThis.__shostIo?.emit('job:progress', payload);
}

export function emitJobLog(data: {
  jobId: number;
  serverId: number;
  hostname: string;
  line: string;
  timestamp: string;
}) {
  getEventBus().emit('job:log', data);
  globalThis.__shostIo?.emit('job:log', data);
}

export function emitJobUpdated(jobId: number) {
  getEventBus().emit('job:updated', { jobId });
  globalThis.__shostIo?.emit('job:updated', { jobId });
}

export function emitVolumeUpdated() {
  getEventBus().emit('volume:updated', {});
  globalThis.__shostIo?.emit('volume:updated', {});
}

export function emitNewAlert(alert: SystemAlert) {
  getEventBus().emit('alert:new', alert);
  globalThis.__shostIo?.emit('alert:new', alert);
}

export function emitSystemUpdateProgress(payload: UpdateProgressEvent) {
  getEventBus().emit('system:update_progress', payload);
  globalThis.__shostIo?.emit('system:update_progress', payload);
}

