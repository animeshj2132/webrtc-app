"use client";
import Link from "next/link";
export default function Page() {
  return (
    <div style={{ padding: 24 }}>
      <h1>WebRTC 1:1 — Demo</h1>
      <p>Create a room and share the link with the other person.</p>
      <Link href="/new" style={{ background: "#16a34a", padding: "10px 14px", borderRadius: 8, display: "inline-block" }}>
        Create New Room
      </Link>
    </div>
  );
}
