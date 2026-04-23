import Link from "next/link";

const SAMPLE_QUERIES = [
  "how does a steam engine work",
  "how a passport is made",
  "anatomy of a cumulus cloud",
  "cross-section of the Eiffel Tower",
];

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col items-center px-6 py-16">
      <div className="flex w-full flex-col items-center text-center">
        <span className="rounded-full border border-[var(--color-ink)]/30 px-3 py-1 text-xs opacity-70">
          an open-source Flipbook clone · BYO keys
        </span>
        <h1 className="mt-6 text-4xl font-bold leading-tight sm:text-6xl">
          Endless Canvas
        </h1>
        <p className="mt-4 max-w-2xl text-lg opacity-80">
          Every page is an AI-generated image. Click anywhere on the image and
          the next page explores whatever you tapped.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/play"
            className="rounded-full bg-[var(--color-ink)] px-6 py-3 text-[var(--color-canvas)]"
          >
            Try the playground
          </Link>
          <a
            href="https://github.com/eren23/openflipbook"
            className="rounded-full border border-[var(--color-ink)] px-6 py-3"
            target="_blank"
            rel="noreferrer"
          >
            Read the code on GitHub
          </a>
        </div>

        <div className="mt-12 w-full">
          <p className="text-xs uppercase tracking-wide opacity-50">
            Or try a sample query
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {SAMPLE_QUERIES.map((q) => (
              <Link
                key={q}
                href={`/play?q=${encodeURIComponent(q)}`}
                className="rounded-full border border-[var(--color-ink)]/30 px-3 py-1 text-sm hover:bg-[var(--color-ink)]/5"
              >
                {q}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <section className="mt-16 w-full">
        <p className="mb-3 text-center text-xs uppercase tracking-wide opacity-50">
          What it looks like
        </p>
        <div className="overflow-hidden rounded-2xl border border-[var(--color-ink)]/20 shadow-lg">
          <video
            src="/demo.mp4"
            poster="/demo-poster.jpg"
            className="block h-auto w-full"
            controls
            muted
            playsInline
            loop
            preload="metadata"
          >
            Your browser does not support embedded video.
          </video>
        </div>
        <p className="mt-3 text-center text-xs opacity-60">
          Real capture of the live stack, sped up 4x — deeplink, two click-to-explore hops. Full playground needs your own keys.
        </p>
      </section>

      <section className="mt-20 grid w-full gap-8 sm:grid-cols-3">
        <div>
          <h3 className="text-base font-bold">1 · Type or upload</h3>
          <p className="mt-2 text-sm opacity-75">
            Give it a question, a topic, or drag in an image to start from.
          </p>
        </div>
        <div>
          <h3 className="text-base font-bold">2 · Get one image</h3>
          <p className="mt-2 text-sm opacity-75">
            A text-capable image model renders a full illustrated page —
            diagrams, annotations, labels, all drawn as pixels.
          </p>
        </div>
        <div>
          <h3 className="text-base font-bold">3 · Tap to explore</h3>
          <p className="mt-2 text-sm opacity-75">
            A vision model resolves the region you clicked and the next page
            expands on it. Permalinks save the graph.
          </p>
        </div>
      </section>

      <section className="mt-20 w-full space-y-4 text-sm leading-relaxed">
        <h2 className="text-xl font-bold">The honest version</h2>
        <p>
          Flipbook&apos;s pitch was &ldquo;every pixel on your screen streamed
          live from a model.&rdquo; In practice, the default experience is a
          static image per page, and the live video stream is a toggle. We
          broke down what&apos;s actually happening in{" "}
          <a
            className="underline"
            href="https://github.com/eren23/openflipbook/blob/main/docs/STORY.md"
          >
            docs/STORY.md
          </a>{" "}
          — including the custom LTXF WebSocket framing they use for the video
          path.
        </p>
        <p>
          The clip above is a real recording of the stack. To run the live
          playground yourself, clone the repo and wire up your own fal,
          OpenRouter, R2, Mongo, and Modal keys — this deploy does not host a
          shared playground. See{" "}
          <a
            className="underline"
            href="https://github.com/eren23/openflipbook/blob/main/docs/BYO-KEYS.md"
          >
            BYO-KEYS.md
          </a>
          .
        </p>
      </section>

      <footer className="mt-20 text-xs opacity-60">
        Paradigm by{" "}
        <a className="underline" href="https://x.com/zan2434" target="_blank" rel="noreferrer">
          Zain Shah
        </a>
        ,{" "}
        <a className="underline" href="https://x.com/eddiejiao_obj" target="_blank" rel="noreferrer">
          Eddie Jiao
        </a>
        ,{" "}
        <a className="underline" href="https://x.com/drewocarr" target="_blank" rel="noreferrer">
          Drew Carr
        </a>
        . Re-implementation by{" "}
        <a className="underline" href="https://github.com/eren23" target="_blank" rel="noreferrer">
          eren23
        </a>
        .
      </footer>
    </main>
  );
}
