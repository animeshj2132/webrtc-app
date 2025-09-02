"use client";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
const CallRoom = dynamic(() => import("../../components/CallRoom"), { ssr: false });
export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  return <CallRoom initialRoomId={params.roomId} />;
}
