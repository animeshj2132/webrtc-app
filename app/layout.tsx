export const metadata = { title: "WebRTC 1:1", description: "Video/Audio/Screen Share" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0e14", color: "white", fontFamily: "Inter, system-ui" }}>
        {children}
      </body>
    </html>
  );
}
