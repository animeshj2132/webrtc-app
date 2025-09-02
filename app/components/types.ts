export type RoomId = string;
export type PeerId = string;

export type SignalMessage =
  | { type: 'join'; payload: { room: RoomId; peerId: PeerId } }
  | { type: 'peers'; payload: { peers: PeerId[] } }
  | { type: 'new-peer'; payload: { peerId: PeerId } }
  | { type: 'offer' | 'answer'; payload: { from: PeerId; to: PeerId; sdp: RTCSessionDescriptionInit } }
  | { type: 'ice'; payload: { from: PeerId; to: PeerId; candidate: RTCIceCandidateInit } }
  | { type: 'leave'; payload: { peerId: PeerId } };
