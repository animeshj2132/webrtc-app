"use client";
import { useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import { useRouter } from "next/navigation";
export default function NewRoom() {
  const router = useRouter();
  useEffect(() => { router.replace(`/r/${uuidv4().slice(0, 8)}`); }, [router]);
  return null;
}
