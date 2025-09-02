"use client";
import React, { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import type { SignalMessage, PeerId, RoomId } from "./types";

const SIGNAL_URL = process.env.NEXT_PUBLIC_SIGNAL_URL || 'wss://server-3gkv.onrender.com';
const TURN_URL = process.env.NEXT_PUBLIC_TURN_URL;
const TURN_USERNAME = process.env.NEXT_PUBLIC_TURN_USERNAME;
const TURN_CREDENTIAL = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun2.l.google.com:19302"] },
  { urls: ["stun:stun3.l.google.com:19302"] },
  { urls: ["stun:stun4.l.google.com:19302"] },
  ...(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL
    ? [{ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL }]
    : [])
];

function useAttachStream(ref: React.RefObject<HTMLVideoElement>, stream: MediaStream | null) {
  useEffect(() => {
    const el = ref.current as HTMLVideoElement | null;
    if (!el) return;
    
    // Attach stream if changed
    if ((el as any).srcObject !== stream) {
      console.log('Attaching stream to video element:', !!stream, stream?.getTracks().length);
      if (stream) {
        console.log('Stream tracks details:');
        stream.getTracks().forEach(track => {
          console.log(`- ${track.kind}: enabled=${track.enabled}, readyState=${track.readyState}, muted=${track.muted}`);
        });
      }
      (el as any).srcObject = stream as any;
    }
    
    if (!stream) return;
    
    // Force playback to avoid autoplay blocking
    const attemptPlay = async () => {
      console.log('Attempting to play video element, readyState:', el.readyState, 'paused:', el.paused);
      
      // Set properties to ensure video can play
      el.muted = true; // Start muted to avoid autoplay blocks
      el.autoplay = true;
      el.playsInline = true;
      
      try {
        const playPromise = el.play();
        if (playPromise) {
          await playPromise;
          console.log('Video playing successfully (muted)');
          
          // Try to unmute after successful play
          setTimeout(() => {
            el.muted = false;
            console.log('Unmuted video');
          }, 500);
        }
      } catch (err: any) {
        console.log('Initial play failed:', err.name, err.message);
        
        // Force play with different strategies
        try {
          el.load(); // Reload the video element
          await new Promise(resolve => setTimeout(resolve, 100));
          await el.play();
          console.log('Video playing after reload');
        } catch (err2) {
          console.log('Reload play failed:', err2);
          
          // Last resort - click simulation
          setTimeout(() => {
            console.log('Attempting click simulation for autoplay');
            el.click();
          }, 1000);
        }
      }
    };
    
    // Multiple play attempts
    const tryPlay = () => {
      attemptPlay();
      // Retry after a short delay
      setTimeout(attemptPlay, 100);
      setTimeout(attemptPlay, 500);
    };
    
    if (el.readyState >= 2) {
      tryPlay();
    } else {
      el.onloadedmetadata = () => {
        console.log('Video metadata loaded, readyState:', el.readyState);
        tryPlay();
      };
      el.oncanplay = () => {
        console.log('Video can play, readyState:', el.readyState);
        tryPlay();
      };
    }
  }, [ref, stream]);
}
interface RemotePeer { peerId: PeerId; pc: RTCPeerConnection; stream: MediaStream; }

export default function CallRoom({ initialRoomId }: { initialRoomId?: string }) {
  const [roomId, setRoomId] = useState<RoomId>(initialRoomId || "demo-room");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [peerId] = useState<PeerId>(() => uuidv4());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState("");
  const [selectedCam, setSelectedCam] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const peersRef = useRef<Map<PeerId, RemotePeer>>(new Map());
  const currentStreamRef = useRef<MediaStream | null>(null);
  const [, setTick] = useState(0);
  const force = () => setTick((x) => x + 1);
  useAttachStream(localVideoRef, localStream);

  async function refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioDevices(devices.filter(d => d.kind === "audioinput"));
    setVideoDevices(devices.filter(d => d.kind === "videoinput"));
  }
  async function getUserMedia(constraints?: MediaStreamConstraints) {
    const stream = await navigator.mediaDevices.getUserMedia(
      constraints ?? {
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
        video: selectedCam ? { deviceId: { exact: selectedCam } } : { width: { ideal: 1280 }, height: { ideal: 720 } }
      }
    );
    currentStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }
  function applySenderBitrateCaps(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        const p = sender.getParameters(); p.encodings = [{ maxBitrate: 1_200_000 }]; sender.setParameters(p).catch(() => {});
      }
      if (sender.track?.kind === 'audio') {
        const p = sender.getParameters(); p.encodings = [{ maxBitrate: 64_000 }]; sender.setParameters(p).catch(() => {});
      }
    }
  }
  function createPC(remoteId: PeerId, streamToUse?: MediaStream) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const remoteStream = new MediaStream();
    
    pc.ontrack = (e) => {
      console.log('Received track from peer', remoteId, 'track kind:', e.track.kind);
      
      // Use the stream from the event if available, otherwise use our created stream
      const incomingStream = e.streams && e.streams.length > 0 ? e.streams[0] : remoteStream;
      
      // If we're using our own stream, add the track to it
      if (incomingStream === remoteStream) {
        remoteStream.addTrack(e.track);
      }
      
      const rp = peersRef.current.get(remoteId);
      if (rp) {
        rp.stream = incomingStream;
      } else {
        peersRef.current.set(remoteId, { peerId: remoteId, pc, stream: incomingStream });
      }
      
      console.log('Remote stream updated for peer', remoteId, 'tracks:', incomingStream.getTracks().length);
      force();
    };    
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current) {
        console.log('Sending ICE candidate to peer:', remoteId, 'type:', e.candidate.type || 'unknown');
        const msg: SignalMessage = { type: "ice", payload: { from: peerId, to: remoteId, candidate: e.candidate.toJSON() } };
        wsRef.current.send(JSON.stringify(msg));
      } else if (!e.candidate) {
        console.log('ICE gathering completed for peer:', remoteId);
      }
    };
    pc.onconnectionstatechange = () => {
      console.log('Connection state changed for peer', remoteId, ':', pc.connectionState);
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        const rp = peersRef.current.get(remoteId); if (rp) rp.stream.getTracks().forEach(t => t.stop());
        pc.close(); peersRef.current.delete(remoteId); force();
      }
    };
    
    // Use the provided stream, current localStream, or the ref
    const currentStream = streamToUse || localStream || currentStreamRef.current;
    if (currentStream) {
      console.log('Adding local stream tracks to peer connection for:', remoteId);
      currentStream.getTracks().forEach(t => {
        console.log('Adding track:', t.kind, 'enabled:', t.enabled);
        pc.addTrack(t, currentStream);
      });
      applySenderBitrateCaps(pc);
    } else {
      console.error('CRITICAL: No local stream available when creating PC for:', remoteId);
    }
    peersRef.current.set(remoteId, { peerId: remoteId, pc, stream: remoteStream });
    return pc;
  }
  async function callPeer(otherId: PeerId) {
    console.log('Calling peer:', otherId);
    const pc = createPC(otherId);
    console.log('Local stream tracks before offer:', localStream?.getTracks().map(t => t.kind));
    const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    console.log('Sending offer to peer:', otherId);
    wsRef.current?.send(JSON.stringify({ type: "offer", payload: { from: peerId, to: otherId, sdp: offer } } as SignalMessage));
  }
  async function join() {
    if (connected || connecting || wsRef.current) {
      console.log('Already connected or connecting, ignoring join attempt');
      return;
    }
    
    setConnecting(true);
    console.log('Joining room:', roomId, 'with peer ID:', peerId);
    console.log('Signal server URL:', SIGNAL_URL);
    
    try {
      // Get media FIRST and ensure it's available in ref
      const stream = await getUserMedia();
      await refreshDevices();
      console.log('Local stream tracks after getUserMedia:', stream?.getTracks().map(t => `${t.kind}: ${t.enabled}`));
      
      // Ensure the ref has the stream
      currentStreamRef.current = stream;
      console.log('Stream available in ref:', !!currentStreamRef.current);
      
      const ws = new WebSocket(SIGNAL_URL);
      wsRef.current = ws;
    ws.onopen = () => {
      console.log('WebSocket connected to signaling server');
      console.log('Local stream available for connections:', !!localStream || !!stream);
      ws.send(JSON.stringify({ type: "join", payload: { room: roomId, peerId } } as SignalMessage));
      setConnected(true);
      setConnecting(false);
    };
    ws.onmessage = async (ev) => {
      const msg: SignalMessage = JSON.parse(ev.data);
      // Newcomer makes the offer to existing peers.
  if (msg.type === "peers") {
  console.log('Received peers list:', msg.payload.peers);
  console.log('Current local stream when receiving peers:', !!localStream, !!stream, !!currentStreamRef.current);
  
  // Ensure we have local stream before making calls
  const currentStream = localStream || stream || currentStreamRef.current;
  if (!currentStream) {
    console.error('CRITICAL: No local stream available when trying to call peers!');
    return;
  }
  
  for (const id of msg.payload.peers) {
    await callPeer(id);
  }
}

// Existing peers do NOT initiate on new-peer; they just wait for the offer.
if (msg.type === "new-peer") {
  // intentionally do nothing — prevents glare
}

      if (msg.type === "offer") {
        const { from, sdp } = msg.payload;
        console.log('Received offer from peer:', from);
        console.log('Local stream available for answer:', !!localStream, !!stream, !!currentStreamRef.current);
        
        // Ensure we have local stream before creating PC
        const currentStream = localStream || stream || currentStreamRef.current;
        if (!currentStream) {
          console.error('CRITICAL: No local stream available when receiving offer from:', from);
          return;
        }
        
        if (!peersRef.current.get(from)) {
          createPC(from, currentStream);
        }
        const pc = peersRef.current.get(from)!.pc;
        
        // Ensure local stream is added to the peer connection
        if (pc.getSenders().length === 0) {
          console.log('Adding local stream to existing PC for:', from);
          currentStream.getTracks().forEach(t => {
            console.log('Adding track to existing PC:', t.kind, 'enabled:', t.enabled);
            pc.addTrack(t, currentStream);
          });
          applySenderBitrateCaps(pc);
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('Sending answer to peer:', from);
        ws.send(JSON.stringify({ type: "answer", payload: { from: peerId, to: from, sdp: answer } } as SignalMessage));
      }
      if (msg.type === "answer") {
        const { from, sdp } = msg.payload; const rp = peersRef.current.get(from); if (!rp) return;
        console.log('Received answer from peer:', from);
        await rp.pc.setRemoteDescription(new RTCSessionDescription(sdp));
        console.log('Set remote description for peer:', from);
      }
      if (msg.type === "ice") {
        const { from, candidate } = msg.payload; const rp = peersRef.current.get(from); if (!rp) return;
        console.log('Received ICE candidate from peer:', from, 'type:', (candidate as any)?.type || 'unknown');
        try { 
          await rp.pc.addIceCandidate(new RTCIceCandidate(candidate)); 
          console.log('Successfully added ICE candidate from peer:', from);
        } catch (err) {
          console.error('Failed to add ICE candidate from peer:', from, err);
        }
      }
      if (msg.type === "leave") {
        const { peerId: leaving } = msg.payload; const rp = peersRef.current.get(leaving); if (!rp) return;
        rp.stream.getTracks().forEach(t => t.stop()); rp.pc.close(); peersRef.current.delete(leaving); force();
      }
    };
    ws.onclose = cleanup;
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      cleanup();
    };
    } catch (error) {
      console.error('Failed to join room:', error);
      cleanup();
    }
  }
  function cleanup() {
    console.log('Cleaning up connection');
    setConnected(false);
    setConnecting(false);
    for (const [, rp] of peersRef.current) { rp.stream.getTracks().forEach(t => t.stop()); rp.pc.close(); }
    peersRef.current.clear();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); setLocalStream(null); }
    if (currentStreamRef.current) { 
      currentStreamRef.current.getTracks().forEach(t => t.stop()); 
      currentStreamRef.current = null; 
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setSharing(false);
  }
  function leave() {
    if (wsRef.current && connected) {
      wsRef.current.send(JSON.stringify({ type: "leave", payload: { peerId } } as SignalMessage));
      wsRef.current.close(); wsRef.current = null;
    }
    cleanup();
  }
  function toggleMic() { if (!localStream) return; const v = !micOn; localStream.getAudioTracks().forEach(t => (t.enabled = v)); setMicOn(v); }
  function toggleCam() { if (!localStream) return; const v = !camOn; localStream.getVideoTracks().forEach(t => (t.enabled = v)); setCamOn(v); }
  async function startShare() {
    if (!localStream) return;
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = display.getVideoTracks()[0];
    // @ts-ignore
    if ('contentHint' in screenTrack) screenTrack.contentHint = 'detail';
    for (const [, rp] of peersRef.current) {
      const sender = rp.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(screenTrack);
    }
    setSharing(true);
    screenTrack.onended = () => stopShare();
  }
  async function stopShare() {
    if (!localStream) return;
    const camTrack = localStream.getVideoTracks()[0];
    for (const [, rp] of peersRef.current) {
      const sender = rp.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(camTrack);
    }
    setSharing(false);
  }
  async function applyDeviceChange(newMicId: string, newCamId: string) {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: newMicId ? { deviceId: { exact: newMicId } } : true,
      video: newCamId ? { deviceId: { exact: newCamId } } : true
    });
    for (const [, rp] of peersRef.current) {
      const senders = rp.pc.getSenders();
      const newAudio = newStream.getAudioTracks()[0];
      const newVideo = newStream.getVideoTracks()[0];
      const a = senders.find(s => s.track?.kind === "audio");
      const v = senders.find(s => s.track?.kind === "video");
      if (a && newAudio) await a.replaceTrack(newAudio);
      if (v && newVideo) await v.replaceTrack(newVideo);
    }
    localStream?.getTracks().forEach(t => t.stop());
    setLocalStream(newStream);
    newStream.getAudioTracks().forEach(t => (t.enabled = micOn));
    newStream.getVideoTracks().forEach(t => (t.enabled = camOn));
  }
  function copyInvite() {
    const url = typeof window !== "undefined" ? `${window.location.origin}/r/${roomId}` : roomId;
    navigator.clipboard.writeText(url).catch(() => {});
    alert("Invite link copied:\\n" + url);
  }
  useEffect(() => {
    const h = () => leave();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  return (
    <div style={{ minHeight: "100vh", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>WebRTC 1:1 — Video/Audio + Screen Share</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Room ID"
          style={{ background: "#111827", border: "1px solid #1f2937", color: "white", borderRadius: 8, padding: "8px 12px" }} />
        {!connected
          ? <button onClick={join} disabled={connecting} style={{ background: connecting ? "#6b7280" : "#16a34a", borderRadius: 8, padding: "8px 14px" }}>
              {connecting ? "Connecting..." : "Join"}
            </button>
          : <button onClick={leave} style={{ background: "#dc2626", borderRadius: 8, padding: "8px 14px" }}>Leave</button>}
        <button onClick={copyInvite} style={{ background: "#2563eb", borderRadius: 8, padding: "8px 14px" }}>Copy Link</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <div style={{ background: "#111827", borderRadius: 16, padding: 12 }}>
          <h2 style={{ margin: 0, marginBottom: 8 }}>You</h2>
          <video ref={localVideoRef} autoPlay playsInline muted style={{ width: "100%", aspectRatio: "16/9", background: "black", borderRadius: 12 }} />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={() => { const v = !micOn; localStream?.getAudioTracks().forEach(t => t.enabled = v); setMicOn(v); }} style={{ background: "#1f2937", borderRadius: 8, padding: "8px 12px" }}>{micOn ? "Mute" : "Unmute"}</button>
            <button onClick={() => { const v = !camOn; localStream?.getVideoTracks().forEach(t => t.enabled = v); setCamOn(v); }} style={{ background: "#1f2937", borderRadius: 8, padding: "8px 12px" }}>{camOn ? "Stop Cam" : "Start Cam"}</button>
            {!sharing
              ? <button onClick={startShare} style={{ background: "#1f2937", borderRadius: 8, padding: "8px 12px" }}>Share Screen</button>
              : <button onClick={stopShare} style={{ background: "#1f2937", borderRadius: 8, padding: "8px 12px" }}>Stop Share</button>}
          </div>

          <DeviceControls
            audioDevices={audioDevices} videoDevices={videoDevices}
            selectedMic={selectedMic} selectedCam={selectedCam}
            setSelectedMic={setSelectedMic} setSelectedCam={setSelectedCam}
            apply={() => applyDeviceChange(selectedMic, selectedCam)}
          />
        </div>

        <Participants peersRef={peersRef} />
      </div>
    </div>
  );
}

function DeviceControls(props: {
  audioDevices: MediaDeviceInfo[]; videoDevices: MediaDeviceInfo[];
  selectedMic: string; selectedCam: string;
  setSelectedMic: (v: string) => void; setSelectedCam: (v: string) => void; apply: () => void;
}) {
  const { audioDevices, videoDevices, selectedMic, selectedCam, setSelectedMic, setSelectedCam, apply } = props;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
      <select value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)} style={{ background: "#0b0e14", border: "1px solid #1f2937", borderRadius: 8, padding: 8 }}>
        <option value="">Default Mic</option>
        {audioDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Microphone"}</option>)}
      </select>
      <select value={selectedCam} onChange={(e) => setSelectedCam(e.target.value)} style={{ background: "#0b0e14", border: "1px solid #1f2937", borderRadius: 8, padding: 8 }}>
        <option value="">Default Camera</option>
        {videoDevices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "Camera"}</option>)}
      </select>
      <button onClick={apply} style={{ gridColumn: "1 / span 2", background: "#2563eb", borderRadius: 8, padding: "8px 12px" }}>Apply Devices</button>
    </div>
  );
}
function Participants({ peersRef }: { peersRef: React.MutableRefObject<Map<PeerId, RemotePeer>> }) {
  const [, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick((x) => x + 1), 500); return () => clearInterval(i); }, []);
  const peers = Array.from(peersRef.current.values());
  return (
    <div style={{ background: "#111827", borderRadius: 16, padding: 12 }}>
      <h2 style={{ margin: 0, marginBottom: 8 }}>Participants</h2>
      {peers.length === 0 ? <div style={{ opacity: 0.7, fontSize: 14 }}>No remote participants yet.</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
          {peers.map((rp) => <RemoteTile key={rp.peerId} rp={rp} />)}
        </div>
      )}
    </div>
  );
}
function RemoteTile({ rp }: { rp: RemotePeer }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  
  useAttachStream(ref, rp.stream);
  
  // Monitor playing state
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    
    const onPlay = () => {
      console.log('Remote video started playing');
      console.log('Video element properties:', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
        paused: video.paused,
        muted: video.muted,
        srcObjectTracks: video.srcObject ? (video.srcObject as MediaStream).getTracks().length : 0
      });
      
      // Check if tracks are enabled
      if (video.srcObject) {
        const stream = video.srcObject as MediaStream;
        stream.getTracks().forEach(track => {
          console.log(`Track ${track.kind}: enabled=${track.enabled}, readyState=${track.readyState}`);
        });
      }
      
      setIsPlaying(true);
    };
    const onPause = () => {
      console.log('Remote video paused');
      setIsPlaying(false);
    };
    
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('playing', onPlay);
    
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('playing', onPlay);
    };
  }, []);
  
  // Force click-to-play as fallback
  const handleClick = async () => {
    if (ref.current) {
      console.log('Manual play attempt on remote video');
      try {
        ref.current.muted = true;
        await ref.current.play();
        console.log('Manual play successful');
        setTimeout(() => {
          if (ref.current) ref.current.muted = false;
        }, 500);
      } catch (e) {
        console.log('Manual play failed:', e);
      }
    }
  };
  
  return (
    <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 8, position: 'relative' }}>
      <video 
        ref={ref} 
        autoPlay 
        playsInline 
        muted={true}
        controls={false}
        onClick={handleClick}
        style={{ 
          width: "100%", 
          aspectRatio: "16/9", 
          background: "black", 
          borderRadius: 8, 
          cursor: "pointer",
          border: "2px solid #00ff00", // Green border for debugging
          objectFit: "cover"
        }} 
      />
      <div style={{ opacity: 0.8, fontSize: 12, marginTop: 4 }}>
        {rp.peerId.slice(0, 8)} - {isPlaying ? 'Playing' : 'Click to play'}
      </div>
      {!isPlaying && (
        <div style={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.8)',
          padding: '12px 16px',
          borderRadius: 8,
          fontSize: 14,
          color: 'white',
          pointerEvents: 'none'
        }}>
          ▶ Click to play
        </div>
      )}
    </div>
  );
}
