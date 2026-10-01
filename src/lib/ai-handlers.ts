/**
 * Shared API handlers — framework-agnostic.
 *
 * Used by the Next.js route handlers (thin wrappers) AND by the Neon Functions
 * Hono app (neon/api/index.ts), so both deployments run identical logic.
 * Only relative imports here: the function bundler has no "@/ " alias.
 */
import { callAIWithFallback, callAIChatText } from "./ai";
import { getGameSetupProfile } from "./game-setup-profiles";

export interface HandlerResult {
  status: number;
  json: any;
}

/** Minimal NextResponse.json stand-in so extracted route bodies stay verbatim. */
const NextResponse = {
  json: (json: any, init?: { status?: number }): HandlerResult => ({
    status: init?.status ?? 200,
    json,
  }),
};

/**
 * Units directive for AI prompts. The client sends `units` ("metric" | "imperial")
 * from the global UnitsContext; the AI must express every number in that system.
 */
/** Fallback-template unit helpers: canonical values are metric-native (psi for tyre pressure). */
const uPsi = (psi: number, units?: string): string =>
  units === "imperial" ? `${psi.toFixed(1)} psi` : `${(psi / 14.5038).toFixed(2)} bar`;
const uPsiRange = (lo: number, hi: number, units?: string): string =>
  units === "imperial" ? `${lo.toFixed(1)}\u2013${hi.toFixed(1)} psi` : `${(lo / 14.5038).toFixed(2)}\u2013${(hi / 14.5038).toFixed(2)} bar`;
const uTemp = (c: number, units?: string): string =>
  units === "imperial" ? `${Math.round((c * 9) / 5 + 32)}\u00B0F` : `${c}\u00B0C`;
/** Speed unit label matching client-converted AI context numbers. */
const spdU = (units?: string): string => (units === "imperial" ? "mph" : "km/h");

export function unitsDirective(units: string | undefined): string {
  if (units === "imperial") {
    return "UNITS: The driver uses IMPERIAL units. Express ALL speeds in mph, ALL temperatures in °F, ALL tyre pressures in psi, distances in feet (miles for long distances), and fuel in US gallons. Never use km/h, °C, bar, meters, or liters in your response.";
  }
  return "UNITS: The driver uses METRIC units. Express ALL speeds in km/h, ALL temperatures in °C, ALL tyre pressures in bar, distances in meters (km for long distances), and fuel in liters. Never use mph, °F, psi, feet, miles, or gallons in your response.";
}


export async function handleGenerateSetup(body: any): Promise<HandlerResult> {

  const {
    game,
    car,
    track,
    sessionType,
    weather,
    trackTemp,
    airTemp,
    fuelLoad,
    tyreCompound,
    driverStyle,
    handlingIssue,
    skillLevel,
    customModProfile,
    units,
  } = body;

  if (!game || !car || !track) {
    return NextResponse.json(
      { error: "Game, car, and track are required." },
      { status: 400 }
    );
  }

  // Resolve the game-authentic profile for the chosen simulator
  const profile = getGameSetupProfile(game);

  // If a custom Assetto Corsa mod physics profile is supplied, format its parameters
  let customModBrief = "";
  if (customModProfile && customModProfile.sliders && customModProfile.sliders.length > 0) {
    const sliderSummary = customModProfile.sliders
      .slice(0, 50)
      .map(
        (s: any) =>
          `• [${s.category}] ${s.name} (${s.key}): Range [${s.min} to ${s.max}], Step: ${s.step}${
            s.defaultValue !== undefined ? `, Default: ${s.defaultValue}` : ""
          }${s.help ? ` (${s.help})` : ""}`
      )
      .join("\n");

    customModBrief = `
AUTHENTIC CUSTOM ASSETTO CORSA MOD PHYSICS DETECTED:
Mod Car: ${customModProfile.name || car} (${customModProfile.brand || "Custom"} by ${customModProfile.author || "Community Modder"})
Mass: ${customModProfile.weightKg ? `${customModProfile.weightKg} kg` : "Unknown"}, Front Weight: ${
      customModProfile.frontWeightRatio
        ? `${(customModProfile.frontWeightRatio * 100).toFixed(1)}% Front`
        : "Unknown"
    }
Ideal Tyre Pressures: ${
      customModProfile.idealTyrePressures
        ? `Front ${customModProfile.idealTyrePressures.front} psi, Rear ${customModProfile.idealTyrePressures.rear} psi`
        : "N/A"
    }

CRITICAL REQUIREMENT: You MUST formulate the setup exclusively using the mod's declared setup.ini parameters below. All values MUST strictly fall within [MIN, MAX] and increment by STEP:
${sliderSummary}
`.trim();
  }

  const userBrief = `
Sim racing title: ${game} (Match in-game setup garage format exactly)
Car: ${car}
Track / layout: ${track}
Session type: ${sessionType || "Not specified"}
Weather: ${weather || "Dry"}
Track temperature: ${trackTemp || "Not specified"}
Air temperature: ${airTemp || "Not specified"}
Fuel load: ${fuelLoad || "Not specified"}
Tyre compound: ${tyreCompound || "Not specified"}
Driver style: ${driverStyle || "Not specified"}
Known handling issue / focus: ${handlingIssue || "None stated, optimize for a balanced all-round setup"}
Driver skill level: ${skillLevel || "Not specified"}

${customModBrief}
`.trim();

  const systemPrompt = `You are a professional race engineer who builds game-authentic car setups for sim racing titles.

CRITICAL INSTRUCTION: You must NEVER output generic setup categories or generic numbers. You must tailor the section titles, parameter labels, units, and click ranges to match the EXACT in-game garage setup menu of "${profile.displayName}".
${customModProfile?.sliders?.length > 0 ? "You have been provided with the user's authentic Assetto Corsa mod setup.ini parameters. Use these EXACT parameter names, units, and limits for the sections." : ""}

${profile.systemPromptGuidance}

${unitsDirective(units)}

Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching this shape:

{
  "summary": "2-3 sentence engineer's summary of the overall philosophy for this setup, explicitly referencing the game-specific physics behavior",
  "sections": [
    {
      "title": "${profile.menuTabs[0]}",
      "items": [
        { "label": "...", "value": "..." }
      ]
    }
  ],
  "engineerNotes": "3-5 sentences explaining the key trade-offs made and how to adjust the in-game clicks/settings if the balance still isn't right, written like a race engineer talking to their driver on the radio."
}

Rules:
- Section titles MUST match the actual garage tabs of ${profile.displayName} (${profile.menuTabs.join(", ")}).
- Use the authentic in-game units: for example in Assetto Corsa, toe is in clicks or mm (e.g. -6 clicks / -1.5mm), dampers are in 0-40 clicks, rear wing in notches 0-12. In F1, wings are 1-50, suspension is 1-41, ARB is 1-21.
- Never use generic placeholder templates.
- Keep all parameter items concrete and numeric as they appear in the game.`;

  try {
    const setup = await callAIWithFallback([
      { role: "system", content: systemPrompt },
      { role: "user", content: userBrief },
    ], 2200, 0.4);

    return NextResponse.json(setup);
  } catch (err: any) {
    console.warn(`AI model generation issue, using game-authentic procedural profile for ${profile.displayName}:`, err?.message || err);

    try {
      const fallbackSetup = profile.generateProceduralSetup({
        car,
        track,
        sessionType,
        weather,
        trackTemp,
        airTemp,
        fuelLoad,
        tyreCompound,
        driverStyle,
        handlingIssue,
        skillLevel,
      });

      return NextResponse.json(fallbackSetup);
    } catch (fallbackErr: any) {
      console.error("Setup generation error:", fallbackErr);
      return NextResponse.json(
        { error: err?.message || "Failed to generate game-specific setup." },
        { status: 500 }
      );
    }
  }
}


interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function handleRaceEngineer(body: any): Promise<HandlerResult> {

  const {
    messages = [],
    telemetryContext,
    setupContext,
    activeSim = "Assetto Corsa Competizione",
    units,
  } = body;

  const lastUserMessage = messages[messages.length - 1]?.content || "";

  // 1. Build rich context summary from active telemetry and setup
  let sessionContextText = `ACTIVE SIMULATOR: ${activeSim}\n`;

  if (setupContext) {
    sessionContextText += `\n--- CURRENT LOADED SETUP ---\n`;
    sessionContextText += `Car: ${setupContext.car || "GT3 / Prototype"}\n`;
    sessionContextText += `Track: ${setupContext.track || "Grand Prix Circuit"}\n`;
    if (setupContext.summary) {
      sessionContextText += `Setup Philosophy: ${setupContext.summary}\n`;
    }
    if (setupContext.sections && Array.isArray(setupContext.sections)) {
      sessionContextText += `Setup Parameters:\n`;
      setupContext.sections.forEach((sec: any) => {
        const itemsStr = (sec.items || [])
          .map((it: any) => `${it.label}: ${it.value}`)
          .slice(0, 6)
          .join(", ");
        sessionContextText += `  • [${sec.title}]: ${itemsStr}\n`;
      });
    }
  }

  if (telemetryContext) {
    sessionContextText += `\n--- SESSION TELEMETRY & LAP ANALYSIS ---\n`;
    if (telemetryContext.lapTime) sessionContextText += `Lap Time: ${telemetryContext.lapTime}\n`;
    if (telemetryContext.topSpeed) sessionContextText += `Top Speed: ${telemetryContext.topSpeed} ${spdU(units)}\n`;
    if (telemetryContext.trailBrakingScore != null) {
      sessionContextText += `Trail-Braking Efficiency Score: ${telemetryContext.trailBrakingScore}/100\n`;
    }
    if (telemetryContext.gripUtilization != null) {
      sessionContextText += `Peak Grip Utilization: ${telemetryContext.gripUtilization}%\n`;
    }
    if (telemetryContext.tyres) {
      const t = telemetryContext.tyres;
      sessionContextText += `Tyre Status: FL ${t.FL?.pressure || ""} (${t.FL?.temp || ""}), FR ${t.FR?.pressure || ""} (${t.FR?.temp || ""}), RL ${t.RL?.pressure || ""} (${t.RL?.temp || ""}), RR ${t.RR?.pressure || ""} (${t.RR?.temp || ""})\n`;
    }
    if (telemetryContext.keyCorners && Array.isArray(telemetryContext.keyCorners)) {
      sessionContextText += `Key Corner Deltas:\n`;
      telemetryContext.keyCorners.slice(0, 5).forEach((c: any) => {
        sessionContextText += `  • ${c.corner}: Speed ${c.driverSpeed} ${spdU(units)} (Δ ${c.speedDelta > 0 ? "+" : ""}${c.speedDelta} ${spdU(units)}), Time Δ ${c.timeDelta > 0 ? "+" : ""}${c.timeDelta}s — ${c.verdict || ""}\n`;
      });
    }
  }

  const systemPrompt = `You are the Chief Race Engineer on the pit wall for an elite sim racing driver, communicating live over the team radio and pit-lane telemetry debrief.
Your tone is professional, direct, analytical, and supportive—modeled after premier F1 and WEC race engineers (like Peter Bonnington "Bono" or Gianpiero Lambiase "GP").

Driver's Session Data:
${sessionContextText}

Guidelines:
1. Always sound like an authentic race engineer on the radio ("Copy driver", "Understood", "Looking at your telemetry trace into...").
2. When the driver asks about handling issues (e.g. oversteer on entry, mid-corner understeer, snap oversteer on kerbs, traction loss):
   - Diagnose whether the issue is mechanical balance, aerodynamic balance, damper transition, or driving technique (e.g. brake release profile).
   - Give CONCRETE, actionable click/setting recommendations tailored to their game (${activeSim}).
3. Use exact simulator units:
   - Assetto Corsa: clicks/mm for toe (-6 clicks / -1.5mm), 0-40 clicks for dampers, differential lock % (40% power / 60% coast).
   - ACC: 0.1 psi pressures, mm ride heights, GT3 ARB steps 1-6, wheel rate N/mm.
   - iRacing: lbs/in or N/mm, brake bias %, click settings.
   - F1 23/24: 1-50 wings, 1-41 suspension, 50-100% on-throttle diff.
4. If recommending setup changes, format them cleanly with bullet points:
   • Component: [Setting Change] (Brief technical rationale)
5. Be concise and high-signal. Avoid fluff or generic motivational padding. Keep answers practical and driver-focused.

${unitsDirective(units)}`;

  try {
    const formattedMessages = [
      { role: "system" as const, content: systemPrompt },
      ...messages.slice(-8).map((m: ChatMessage) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    const reply = await callAIChatText(formattedMessages, 1200, 0.6);
    return NextResponse.json({ reply });
  } catch (err: any) {
    console.warn("AI Gateway chat error, falling back to procedural race engineer response:", err?.message || err);

    // Procedural Motorsport Race Engineer Fallback
    const fallbackReply = generateProceduralEngineerResponse(
      lastUserMessage,
      activeSim,
      setupContext,
      telemetryContext,
      units
    );

    return NextResponse.json({ reply: fallbackReply });
  }
}

/**
 * Intelligent Procedural Race Engineer fallback if AI API is offline or rate-limited
 */
function generateProceduralEngineerResponse(
  userQuery: string,
  sim: string,
  setupContext?: any,
  telemetryContext?: any,
  units?: string
): string {
  const query = userQuery.toLowerCase();
  const car = setupContext?.car || "your car";
  const track = setupContext?.track || "this circuit";

  if (query.includes("oversteer") && (query.includes("entry") || query.includes("trail") || query.includes("braking"))) {
    return `Copy driver, entry oversteer under trail braking is usually caused by excessive forward weight transfer unloading the rear axle or differential coast lock releasing too abruptly.

Here is what we recommend on the telemetry data for ${sim}:
• **Rear Anti-Roll Bar**: Soften by 1 step (increases rear mechanical grip during corner entry roll).
• **Differential Coast / Preload**: Increase coast lock (+5% to +10%) or bump preload by +10–15 Nm to keep the rear axle unified under deceleration.
• **Front Brake Bias**: Shift forward by +0.8% to +1.2% to stabilize the rear under heavy initial braking.
• **Front Bump / Rear Rebound Dampers**: Add 1 click front bump or soften rear rebound by 1–2 clicks to slow down forward pitch rate.

Driving note: smooth out your brake release on turn-in. If you snap off the brake pedal instantly, the rear unweights and steps out.`;
  }

  if (query.includes("understeer") || query.includes("push") || query.includes("scrub")) {
    return `Understood driver. The front end is washing out and scrubbing front tyre compound. Looking at the setup baseline for ${car} at ${track}:

To induce turn-in rotation and cure front push:
• **Front Anti-Roll Bar**: Drop by 1 notch (softening front roll stiffness increases front mechanical grip).
• **Front Toe**: Add negative toe (toe-out) by -2 to -4 clicks or -0.05° to sharpen initial steering turn-in response.
• **Front Ride Height / Aero Rake**: Drop front ride height by 2–3mm or raise rear ride height by 3mm to shift aerodynamic balance forward.
• **Brake Bias**: Move rearward by 0.5%–1.0% to allow the car to pivot around the center of mass under trail braking.

Monitor your steering input: if you exceed 90° of wheel lock while the car is pushing, you're scrubbing grip. Back off the steering angle slightly to let the front bite.`;
  }

  if (query.includes("tyre") || query.includes("pressure") || query.includes("temp") || query.includes("psi")) {
    const t = telemetryContext?.tyres;
    const flP = t?.FL?.pressure || uPsi(26.8, units);
    const frP = t?.FR?.pressure || uPsi(27.1, units);

    return `Radio check driver, let's review your tyre telemetry.
Current hot readings: FL at ${flP}, FR at ${frP}.

For ${sim}:
• **Target Operating Window**: GT3 slicks operate best at ${uPsiRange(26.8, 27.2, units)} hot. If you're building beyond ${uPsi(27.5, units)}, you'll lose lateral traction and overheat the shoulders.
• **Asymmetric Loading**: On clockwise circuits like Spa and Monza, the front-left and rear-left take high lateral load. Start cold pressures on the left side roughly ${uPsiRange(0.3, 0.5, units)} lower than the right to equalize hot pressures mid-stint.
• **Camber Adjustment**: If inner temps are >${uTemp(15, units)} hotter than outer temps, decrease negative camber by 0.2° to prevent blistering on the inside shoulder.`;
  }

  if (query.includes("turn 1") || query.includes("t1") || query.includes("hairpin") || query.includes("la source")) {
    return `Looking at the Turn 1 telemetry trace:
The key to Turn 1 is squaring off the exit for maximum traction onto the following straight.
• **Braking**: Peak deceleration needs to happen in a straight line before steering lock. Don't carry deep trail-braking past the apex or you'll delay throttle pickup.
• **Mechanical Setup Fix**: If you're getting exit power oversteer out of the hairpin, soften rear suspension spring rates or lower rear tyre pressures by ${uPsi(0.2, units)} to plant the rear contact patch.`;
  }

  if (query.includes("kerb") || query.includes("bump") || query.includes("chicane")) {
    return `Copy driver. When attacking chicanes like the Bus Stop or Ascari, kerb compliance is determined by your fast damper valving.

Recommended adjustments for ${sim}:
• **Fast Bump Dampers**: Soften front and rear fast-bump by 2 clicks. This allows the suspension to compress quickly over kerb strikes without kicking the chassis into the air.
• **Bump Stop Range**: Increase bump stop window by 3–5mm so the suspension doesn't abruptly hit the hard rubber stops over aggressive kerbing.`;
  }

  // General Technical Debrief
  return `Copy driver, loud and clear on pit wall telemetry.
Looking at ${car} around ${track} in ${sim}:

Our primary focus is optimizing the transition between trail-braking and throttle commit. Let me know specifically:
1. Are you struggling with low-speed mechanical turn-in or high-speed aerodynamic stability?
2. How is tyre wear and pressure drift progressing through your stint?
3. Which specific corner or sector is costing you the most lap time against your target?

Give me your feedback and I'll call out the exact click adjustments to make in the garage.`;
}


function getDefaultAdaptiveSetup(car: string, track: string, driverStyle: string, balancePreference: string, units?: string) {
  return {
    philosophy: `Engineered specifically for your ${driverStyle || "Heavy Trail-Braker"} technique and ${balancePreference || "Neutral Balance"} requirement on ${track}. The mechanical roll balance has been softened at the front axle to maximize contact patch grip under trail-braking, eliminating understeer while keeping the rear axle stable on power exit.`,
    sections: [
      {
        title: "Tyres & Cold Pressures",
        items: [
          { label: "Front Left Cold Pressure", value: `${uPsi(26.4, units)}`, styleNote: "Compensates for high lateral loading" },
          { label: "Front Right Cold Pressure", value: `${uPsi(26.7, units)}`, styleNote: "Matches circuit corner weight distribution" },
          { label: "Rear Left Cold Pressure", value: `${uPsi(26.2, units)}`, styleNote: "Maximizes traction patch on exit drive" },
          { label: "Rear Right Cold Pressure", value: `${uPsi(26.4, units)}`, styleNote: "Equalizes thermal spread" },
        ],
      },
      {
        title: "Suspension & Wheel Alignment",
        items: [
          { label: "Front Anti-Roll Bar", value: "3 / 6 (Medium-Soft)", styleNote: "Softened to cure apex scrub" },
          { label: "Rear Anti-Roll Bar", value: "2 / 6 (Soft)", styleNote: "Keeps rear axle planted on throttle" },
          { label: "Front Camber", value: "-3.6°", styleNote: "Optimized for maximum lateral G" },
          { label: "Rear Camber", value: "-2.8°", styleNote: "Balanced traction vs lateral support" },
          { label: "Front Toe", value: "-0.08° (Toe-out)", styleNote: "Sharpens turn-in response" },
          { label: "Rear Toe", value: "+0.16° (Toe-in)", styleNote: "High-speed braking stability" },
        ],
      },
      {
        title: "Dampers (Bump & Rebound)",
        items: [
          { label: "Front Low-Speed Bump", value: "5 / 11", styleNote: "Absorbs pitch transitions cleanly" },
          { label: "Rear Low-Speed Rebound", value: "7 / 11", styleNote: "Controls rear axle rise under braking" },
        ],
      },
      {
        title: "Aerodynamics & Ride Height",
        items: [
          { label: "Front Ride Height", value: "52 mm", styleNote: "Maximizes front underbody suction" },
          { label: "Rear Wing Angle", value: "8 / 12", styleNote: "High-speed rear stability" },
        ],
      },
      {
        title: "Differential & Drivetrain",
        items: [
          { label: "Diff Preload / Coast Lock", value: "60 Nm", styleNote: "Facilitates off-throttle rotation" },
        ],
      },
      {
        title: "Brakes & Electronics",
        items: [
          { label: "Brake Bias", value: "54.2% (Rearward Shift)", styleNote: "Aids trail-braking rotation without front lockup" },
          { label: "ABS Setting", value: "3 / 11", styleNote: "Permits driver pedal modulation" },
          { label: "Traction Control (TC1)", value: "3 / 11", styleNote: "Permits optimal slip angle on exit" },
        ],
      },
    ],
  };
}

export async function handleAnalyzeTelemetry(body: any): Promise<HandlerResult> {
  try {
    const {
      game,
      car,
      track,
      sessionType,
      weather,
      trackTemp,
      airTemp,
      tyreCompound,
      fuelLoad,
      driverStyle,
      balancePreference,
      setupTarget,
      driverComplaint,
      summaryMetrics,
      sampledPoints,
      anomalies,
      lapComparison,
      frictionCircle,
      units,
    } = body;

    if (!game || !car || !track) {
      return NextResponse.json(
        { error: "Game, car, and track are required for telemetry analysis." },
        { status: 400 }
      );
    }

    const comparisonText = lapComparison
      ? `
=== BENCHMARK COMPARISON ===
Ref Lap: ${lapComparison.refLapTime}, Pace Gap: +${lapComparison.totalTimeDeltaSeconds}s
Top Speed Delta: ${lapComparison.topSpeedDeltaKmh > 0 ? "+" : ""}${lapComparison.topSpeedDeltaKmh} km/h
Corners:
${(lapComparison.cornerComparisons || [])
  .slice(0, 8)
  .map(
    (c: any) =>
      `- ${c.corner}: Apex ${c.driverMinSpeed} km/h (Ref ${c.refMinSpeed}), Brk: ${c.brakingPointDeltaMeters}m, Δt: ${c.timeDelta > 0 ? "+" : ""}${c.timeDelta}s`
  )
  .join("\n")}
`
      : "";

    const frictionCircleText = frictionCircle
      ? `
=== G-G FRICTION CIRCLE ===
Grip Util: ${frictionCircle.gripUtilizationPct}%, Trail-Brk Eff: ${frictionCircle.trailBrakingTransitionEfficiency}/100, Peak Comb: ${frictionCircle.peakCombinedG}G, Peak Decel: ${frictionCircle.peakDecelG}G, Lat: ${frictionCircle.peakLatG}G
Quadrants: Entry-L=${frictionCircle.quadrantStats?.trailBrakingLeftGripPct ?? "N/A"}%, Entry-R=${frictionCircle.quadrantStats?.trailBrakingRightGripPct ?? "N/A"}%, Exit-L=${frictionCircle.quadrantStats?.powerDownLeftGripPct ?? "N/A"}%, Exit-R=${frictionCircle.quadrantStats?.powerDownRightGripPct ?? "N/A"}%
Diagnosis: ${frictionCircle.verdict || "Standard envelope"}
`
      : "";

    // Compact telemetry slice (12 key telemetry points)
    const compactTelemetrySlice = (sampledPoints || [])
      .filter((_: any, idx: number) => idx % 3 === 0)
      .slice(0, 14)
      .map(
        (p: any) =>
          `[${p.dist}m: v=${p.speed}, thr=${p.throttle}%, brk=${p.brake}%, str=${p.steer}°, g=${p.latG}/${p.longG}]`
      )
      .join(", ");

    const telemetryReport = `
=== TELEMETRY INGEST SESSION ===
Sim: ${game} | Car: ${car} | Track: ${track} | Weather: ${weather || "Dry"} (${trackTemp || "30°C"} track, ${airTemp || "22°C"} air) | Fuel: ${fuelLoad || "35 L"}
Driver Style: ${driverStyle || "Heavy Trail-Braker"} | Balance Target: ${balancePreference || "Neutral Balance"} | Target: ${setupTarget || "Qualifying Hotlap"}
Driver Complaint: ${driverComplaint || "Analyze overall lap pace, entry stability, and apex rotation"}

=== METRICS ===
Lap Time: ${summaryMetrics?.lapTime || "N/A"} | Top Speed: ${summaryMetrics?.topSpeed || "N/A"} ${spdU(units)}
Trail-Braking Score: ${summaryMetrics?.trailBrakingScore ?? 75}/100 | Throttle Score: ${summaryMetrics?.throttleSmoothness ?? 80}/100 | Scrub Index: ${summaryMetrics?.steeringScrub ?? 70}/100
Peak Braking Decel: ${summaryMetrics?.maxDecelG ?? 1.8} G | Peak Lat Accel: ${summaryMetrics?.maxLatG ?? 2.2} G
Tyres (FL/FR/RL/RR): ${summaryMetrics?.tyres?.FL?.temp || uTemp(84, units)}/${summaryMetrics?.tyres?.FR?.temp || uTemp(86, units)}/${summaryMetrics?.tyres?.RL?.temp || uTemp(82, units)}/${summaryMetrics?.tyres?.RR?.temp || uTemp(83, units)}
${comparisonText}
${frictionCircleText}
Telemetry Traces: ${compactTelemetrySlice}
`.trim();

    const systemPrompt = `You are a World-Class Chief Performance & Race Telemetry Engineer (F1 & GT3 vehicle dynamics expert).
Analyze the telemetry metrics and synthesize an in-depth diagnosis plus a COMPLETE, CALIBRATED CAR SETUP tailored to the driver's natural driving style (${driverStyle || 'Heavy Trail-Braker'}) and balance preference (${balancePreference || 'Neutral Balance'}).

${unitsDirective(units)}

Output ONLY valid JSON matching this schema:
{
  "overallScore": number (1-100),
  "verdictTitle": "string",
  "lapTimeObserved": "${summaryMetrics?.lapTime || '2:17.482'}",
  "estimatedTimeLost": "string (e.g. 0.65s - 0.95s)",
  "primaryLimiter": "string",
  "executiveSummary": "2-3 authoritative sentences analyzing pace, tyre loading, G-G envelope utilization, and handling flaws.",
  "kpiRatings": [
    { "name": "Trail Braking", "score": number, "status": "Needs Work"|"Fair"|"Good"|"Optimal", "feedback": "string" },
    { "name": "Throttle Traction", "score": number, "status": "string", "feedback": "string" },
    { "name": "Steering Efficiency", "score": number, "status": "string", "feedback": "string" },
    { "name": "Tyre Management", "score": number, "status": "string", "feedback": "string" },
    { "name": "Chassis Balance", "score": number, "status": "string", "feedback": "string" }
  ],
  "cornerBreakdowns": [
    {
      "corner": "Corner name",
      "timeDelta": "+0.XXs",
      "driverInput": "Driver pedal/wheel action",
      "chassisResponse": "Chassis pitch/roll/slip reaction",
      "actionableFix": "Coaching cue"
    }
  ],
  "driverCoaching": [
    { "phase": "Braking & Entry", "icon": "brake", "tip": "string" },
    { "phase": "Apex & Rotation", "icon": "steer", "tip": "string" },
    { "phase": "Exit & Power Delivery", "icon": "throttle", "tip": "string" }
  ],
  "setupAdjustments": [
    { "category": "Anti-Roll Bars", "component": "string", "adjustment": "string", "rationale": "string" },
    { "category": "Dampers", "component": "string", "adjustment": "string", "rationale": "string" },
    { "category": "Brakes", "component": "string", "adjustment": "string", "rationale": "string" }
  ],
  "adaptiveSetup": {
    "philosophy": "Detailed explanation of how this setup is engineered around driver style ${driverStyle} and balance preference ${balancePreference}.",
    "sections": [
      {
        "title": "Tyres & Cold Pressures",
        "items": [
          { "label": "Front Left Cold Pressure", "value": "26.4 psi", "styleNote": "string" },
          { "label": "Front Right Cold Pressure", "value": "26.7 psi", "styleNote": "string" },
          { "label": "Rear Left Cold Pressure", "value": "26.2 psi", "styleNote": "string" },
          { "label": "Rear Right Cold Pressure", "value": "26.4 psi", "styleNote": "string" }
        ]
      },
      {
        "title": "Suspension & Wheel Alignment",
        "items": [
          { "label": "Front Anti-Roll Bar", "value": "3 / 6 (Medium)", "styleNote": "string" },
          { "label": "Rear Anti-Roll Bar", "value": "2 / 6 (Soft)", "styleNote": "string" },
          { "label": "Front Camber", "value": "-3.6°", "styleNote": "string" },
          { "label": "Rear Camber", "value": "-2.8°", "styleNote": "string" },
          { "label": "Front Toe", "value": "-0.08° (Toe-out)", "styleNote": "string" },
          { "label": "Rear Toe", "value": "+0.16° (Toe-in)", "styleNote": "string" }
        ]
      },
      {
        "title": "Dampers (Bump & Rebound)",
        "items": [
          { "label": "Front Low-Speed Bump", "value": "6 / 11", "styleNote": "string" },
          { "label": "Rear Low-Speed Rebound", "value": "7 / 11", "styleNote": "string" }
        ]
      },
      {
        "title": "Aerodynamics & Ride Height",
        "items": [
          { "label": "Front Ride Height", "value": "52 mm", "styleNote": "string" },
          { "label": "Rear Wing Angle", "value": "8 / 12", "styleNote": "string" }
        ]
      },
      {
        "title": "Differential & Drivetrain",
        "items": [
          { "label": "Diff Preload / Coast Lock", "value": "60 Nm", "styleNote": "string" }
        ]
      },
      {
        "title": "Brakes & Electronics",
        "items": [
          { "label": "Brake Bias", "value": "54.2% (Rearward Shift)", "styleNote": "string" },
          { "label": "ABS Setting", "value": "3 / 11", "styleNote": "string" },
          { "label": "Traction Control (TC1)", "value": "3 / 11", "styleNote": "string" }
        ]
      }
    ]
  },
  "pitRadioMessage": "Radio message from Chief Race Engineer to driver."
}`;

    try {
      const analysis = await callAIWithFallback(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: telemetryReport },
        ],
        1800,
        0.4
      );
      if (!analysis.adaptiveSetup || !analysis.adaptiveSetup.sections || analysis.adaptiveSetup.sections.length === 0) {
        analysis.adaptiveSetup = getDefaultAdaptiveSetup(car, track, driverStyle, balancePreference, units);
      }
      if (!analysis.pitRadioMessage) {
        analysis.pitRadioMessage = `“Box this lap, telemetry confirmed. We've applied your ${driverStyle} setup calibration. Attack the entries with confidence.”`;
      }
      return NextResponse.json(analysis);
    } catch (apiErr: any) {
      console.warn("AI Gateway error encountered, activating deterministic telemetry synthesis:", apiErr?.message);
      
      // Fallback synthesis grounded directly in telemetry data
      const trailScore = summaryMetrics?.trailBrakingScore ?? 74;
      const throttleScore = summaryMetrics?.throttleSmoothness ?? 82;
      const scrubScore = summaryMetrics?.steeringScrub ?? 71;
      const gripPct = frictionCircle?.gripUtilizationPct ?? 78;
      const transitionEff = frictionCircle?.trailBrakingTransitionEfficiency ?? 72;
      const overallScore = Math.round((trailScore * 0.35) + (throttleScore * 0.25) + (scrubScore * 0.2) + (gripPct * 0.2));

      const fallbackResult = {
        overallScore,
        verdictTitle: trailScore < 75 
          ? "Abrupt Trail-Braking Decay with Mid-Corner Understeer" 
          : "Solid Pace with Traction Envelope Under-Utilization",
        lapTimeObserved: summaryMetrics?.lapTime || "2:17.482",
        estimatedTimeLost: lapComparison ? `+${lapComparison.totalTimeDeltaSeconds}s vs Pro` : "0.65s - 0.95s",
        primaryLimiter: trailScore < 75 ? "Braking Release Rate & Scrub Angle" : "Traction Exit Hesitation",
        executiveSummary: `Lap telemetry shows a competitive initial deceleration of ${summaryMetrics?.maxDecelG || 1.8}G, but the G-G friction envelope indicates a ${gripPct}% grip utilization rate with premature brake release into apex. Vehicle yaw response is impeded by high steering scrub (${scrubScore}/100), delaying full throttle application on exit.`,
        kpiRatings: [
          {
            name: "Trail Braking",
            score: trailScore,
            status: trailScore >= 80 ? "Optimal" : trailScore >= 70 ? "Fair" : "Needs Work",
            feedback: `Deceleration decay is squared off rather than circular (${transitionEff}/100 transition quality). Smooth the final 15% of brake pressure to carry higher rolling speed.`,
          },
          {
            name: "Throttle Traction",
            score: throttleScore,
            status: throttleScore >= 80 ? "Good" : "Fair",
            feedback: "Progressive throttle application on corner exit with minimal micro-hesitations.",
          },
          {
            name: "Steering Efficiency",
            score: scrubScore,
            status: scrubScore >= 80 ? "Optimal" : "Understeer",
            feedback: "Excessive steering angle applied past apex, causing front tyre scrub and thermal buildup.",
          },
          {
            name: "Tyre Management",
            score: 86,
            status: "Optimal",
            feedback: `Hot pressures (${summaryMetrics?.tyres?.FL?.pressure || uPsi(27.2, units)} FL, ${summaryMetrics?.tyres?.FR?.pressure || uPsi(27.4, units)} FR) remain well within the working window.`,
          },
          {
            name: "Chassis Balance",
            score: 75,
            status: balancePreference.includes("Loose") ? "Oversteer" : "Understeer",
            feedback: `Mechanical roll balance is front-biased, restricting apex rotation in medium-speed complexes.`,
          },
        ],
        cornerBreakdowns: (lapComparison?.cornerComparisons || []).slice(0, 4).map((c: any) => ({
          corner: c.corner,
          timeDelta: c.timeDelta > 0 ? `+${c.timeDelta}s` : `${c.timeDelta}s`,
          driverInput: c.speedDelta < -3 ? "Abrupt brake release followed by steering over-correction" : "Early throttle lift with cautious commitment",
          chassisResponse: "Front tyre slip angle peaks prematurely, washing wide of geometric apex",
          actionableFix: `Trail brake 5m deeper while bleeding off pressure smoothly to carry ${Math.abs(c.speedDelta || 3)} km/h more apex speed.`,
        })),
        driverCoaching: [
          {
            phase: "Braking & Entry",
            icon: "brake",
            tip: "Trail the brake pedal down to 10% past turn-in instead of dropping directly from 60% to 0%.",
          },
          {
            phase: "Apex & Rotation",
            icon: "steer",
            tip: "Unwind 5° of steering lock as you reach the apex kerb to let the front tyres generate lateral grip.",
          },
          {
            phase: "Exit & Power Delivery",
            icon: "throttle",
            tip: "Commit to continuous throttle squeeze once the steering is unwinding; avoid mid-corner hesitations.",
          },
        ],
        setupAdjustments: [
          {
            category: "Anti-Roll Bars",
            component: "Front Anti-Roll Bar",
            adjustment: "-1 click (Softer)",
            rationale: "Reduces front roll resistance, promoting mechanical front-end bite and mid-corner rotation.",
          },
          {
            category: "Brakes & Electronics",
            component: "Brake Bias",
            adjustment: "-0.5% (Rearward)",
            rationale: "Shifts dynamic braking load rearward to aid vehicle rotation on trail-braking entry.",
          },
          {
            category: "Dampers",
            component: "Front Low-Speed Bump",
            adjustment: "-1 click",
            rationale: "Improves bump compliance over apex kerbing and prevents front wash under lateral transition.",
          },
        ],
        adaptiveSetup: getDefaultAdaptiveSetup(car, track, driverStyle, balancePreference, units),
        pitRadioMessage: `“Box this lap, telemetry looks clear. We're bleeding 3 tenths on entry by dropping the brake too fast. We've dialed in 1 click softer on the front ARB and bumped rear brake bias back half a percent. Get back out there and trust the front.”`,
      };

      return NextResponse.json(fallbackResult);
    }
  } catch (fatalErr: any) {
    console.error("Fatal telemetry route error:", fatalErr);
    return NextResponse.json(
      { error: "Could not process telemetry dataset." },
      { status: 500 }
    );
  }
}
