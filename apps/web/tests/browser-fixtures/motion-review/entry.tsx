import { useState } from "react";
import { createRoot } from "react-dom/client";
import MotionReview from "@/components/sketch/motion-review";
import { motionComparisonPlan } from "@/lib/motion-comparison";
import { motionStudyFixture } from "@/tests/fixtures/motion-study";
function Fixture() {
  const [open, setOpen] = useState(false), [saved, setSaved] = useState<unknown>(null);
  return <main style={{ fontFamily: "system-ui", padding: 24 }}><h1>Browser test / synthetic media</h1>
    <button onClick={() => setOpen(true)}>Open comparison fixture</button>
    {open && <MotionReview sessionId="world" studyId="study" assetId="clip" comparison={{ sha256: "fixture", plan: motionComparisonPlan(motionStudyFixture()) }}
      media={{ width: 640, height: 480, duration: 6 }} onClose={() => setOpen(false)} onSave={async body => { setSaved(body); return true; }}/>}
    <pre aria-label="Test save receipt">{saved ? JSON.stringify(saved, null, 2) : "Nothing saved"}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
