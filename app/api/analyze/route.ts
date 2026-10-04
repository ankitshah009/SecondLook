import { NextResponse } from "next/server";
import { analyzeRequestSchema } from "@/lib/second-look";
import { analyzeOffer } from "@/lib/workflow";

export const maxDuration = 120;
export async function POST(request: Request) {
  let input;
  try { input = analyzeRequestSchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Enter a valid offer URL and payment preferences." }, { status: 400 }); }
  const origin = new URL(request.url).origin;
  if (!request.headers.get("accept")?.includes("text/event-stream")) {
    try { return NextResponse.json(await analyzeOffer(input, origin, undefined, request.signal)); }
    catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Inspection is unavailable. No quote was created." }, { status: 503 });
    }
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let disconnected = false;
      const send = (type: string, data: unknown) => {
        if (disconnected || request.signal.aborted) return;
        try { controller.enqueue(encoder.encode("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n")); }
        catch { disconnected = true; }
      };
      try { send("result", await analyzeOffer(input, origin, progress => send("progress", progress), request.signal, frame => send("capture", frame))); }
      catch (error) { send("error", { error: error instanceof Error ? error.message : "Inspection is unavailable. No quote was created." }); }
      finally { if (!disconnected) controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
