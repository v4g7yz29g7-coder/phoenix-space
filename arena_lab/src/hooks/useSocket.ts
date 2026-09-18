import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useArena } from '../store/arena';

let socket: Socket | null = null;

export function useSocket(url = '/') {
  const { setConnected, onRaceStart, onRaceTick, onRaceFinish, onRadioEvent } = useArena();

  useEffect(() => {
    if (!socket) {
      socket = io(url, {
        transports: ['polling'],
        reconnection: true,
      });
    }

    socket.on('connect', () => {
      console.log('[socket] connected:', socket?.id);
      setConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('[socket] disconnected');
      setConnected(false);
    });

    socket.on('radio:event', onRadioEvent);
    socket.on('race:start', (data: any) => {
      onRaceStart(data.race_id, data.agents || [], data.task || '');
    });
    socket.on('race:tick', (data: any) => {
      onRaceTick(data.positions || []);
    });
    socket.on('race:finish', (data: any) => {
      onRaceFinish(data.winner, data.results || []);
    });

    return () => {
      socket?.off('radio:event', onRadioEvent);
    };
  }, [setConnected, onRaceStart, onRaceTick, onRaceFinish, onRadioEvent]);

  return socket;
}
