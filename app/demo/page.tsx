import { Suspense } from "react";
import DemoClient from "./DemoClient";

export const metadata = { title: "SameTaste, a receipt on the counter" };

/** The scripted persona flow replayed from its recording (GET /api/recording/:persona: the live one from KV, else the bundled mock one). */
export default function DemoPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#e8e2d6" }} />}>
      <DemoClient />
    </Suspense>
  );
}
