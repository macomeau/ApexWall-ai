/**
 * Setup knowledge base seed data for ApexWall-ai RAG.
 *
 * Each entry: title, body (the engineering guidance), category, tags.
 * Bodies are written for retrieval: symptom-first language the driver
 * would use, followed by the engineering fix. This maximizes both
 * keyword hits ("understeer", "ARB") and semantic matches
 * ("car won't turn", "pushes wide").
 */
export interface KnowledgeEntry {
  title: string;
  body: string;
  category: string;
  tags: string[];
}

export const SETUP_KNOWLEDGE: KnowledgeEntry[] = [
  {
    title: "Corner-exit understeer (power-on push)",
    body: "SYMPTOM: Car pushes wide when applying throttle out of slow/medium corners; need to wait before getting on power. FIX: Soften rear anti-roll bar 1-2 clicks to increase rear mechanical grip on exit. Alternatively reduce rear ride height 2-3mm to shift aero balance rearward. If differential is adjustable, reduce power ramp angle or preload to let the inside wheel rotate. Reduce rear tyre pressure 0.1-0.2 bar if rears are overheating. Driving: unwind steering earlier and be more progressive with throttle application.",
    category: "balance",
    tags: ["understeer", "exit", "power-on", "push", "arb", "differential", "ride-height"],
  },
  {
    title: "Corner-entry understeer (won't turn in)",
    body: "SYMPTOM: Car resists initial turn-in; have to add extra steering lock; front washes wide on entry. FIX: Stiffen front anti-roll bar OR soften rear ARB to shift balance forward. Increase front downforce (more front wing) or reduce rear wing. Move brake bias forward 1-2% to load the front on entry. Increase front camber (more negative, -0.2°) for better turn-in bite. Soften front bump to let the nose dive and load the front tyres. Driving: brake slightly later and trail deeper to keep load on the nose.",
    category: "balance",
    tags: ["understeer", "entry", "turn-in", "arb", "brake-bias", "camber", "aero"],
  },
  {
    title: "Mid-corner understeer (apex push)",
    body: "SYMPTOM: Car won't rotate at the apex; stuck on a wide line through the middle of the corner. FIX: This is usually aero or geometry. Increase front wing or reduce rear wing 1 click. More front camber (-3.5° to -4.0° typical for GT3). Reduce front ride height for more front downforce (watch plank wear). Stiffen front springs slightly to reduce roll-induced camber loss. If mechanical: soften rear ARB. Driving: slower hands — sawing at the wheel scrubs speed; commit to one steering input.",
    category: "balance",
    tags: ["understeer", "mid-corner", "apex", "aero", "camber", "springs"],
  },
  {
    title: "Corner-exit oversteer (power-on loose)",
    body: "SYMPTOM: Rear steps out when applying throttle on exit; need to catch slides on power. FIX: Stiffen rear anti-roll bar 1-2 clicks. Increase rear wing 1-2 clicks for more rear downforce. Increase differential power ramp/preload to lock the rear under power. Raise rear ride height slightly OR lower front to shift aero forward. Reduce rear tyre pressure if sliding from overheating. Increase traction control 1-2 clicks as a driver aid. Driving: be more progressive on throttle; short-shift early in the exit phase.",
    category: "balance",
    tags: ["oversteer", "exit", "power-on", "loose", "arb", "differential", "tc"],
  },
  {
    title: "Corner-entry oversteer (rear nervous on brakes)",
    body: "SYMPTOM: Rear feels light or steps out under braking into the corner; nervous on turn-in. FIX: Move brake bias rearward... no wait — move brake bias FORWARD 1-2% to stabilize the rear under braking. Increase rear wing for braking stability. Stiffen front bump to reduce dive (less weight transfer off the rear). Increase differential coast ramp to stabilize off-throttle. Raise rear ride height for more diffuser stall resistance. Driving: brake in a straight line longer; less trail-braking rotation.",
    category: "balance",
    tags: ["oversteer", "entry", "braking", "brake-bias", "differential", "aero"],
  },
  {
    title: "High-speed oversteer (fast corners)",
    body: "SYMPTOM: Rear unstable in fast sweepers; car feels nervous above 200 km/h. FIX: This is almost always aero. Add rear wing 2-3 clicks. Raise rear ride height 3-5mm to keep the diffuser working (too low = stall). Reduce rear camber if the tyre is rolling onto its edge. Stiffen rear springs to control aero platform. Check tyre pressures — overheated rears lose grip at speed. Driving: smoother steering inputs; fast corners punish aggression.",
    category: "balance",
    tags: ["oversteer", "high-speed", "aero", "wing", "ride-height", "diffuser"],
  },
  {
    title: "Tyre pressure optimization (hot targets)",
    body: "SYMPTOM: Tyres overheating, graining, or lacking grip; inconsistent across a stint. FIX: Target hot pressures per manufacturer's window (GT3 typically 27.5-28.0 psi hot / 1.90-1.93 bar). Set cold pressures so you REACH the hot target after 3-4 laps — usually 1.5-2.0 psi below hot target. If inside edge overheating: reduce camber. If center overheating: reduce pressure. If outer edge: increase camber. Front/rear split affects balance: lower front pressure = more front grip (less understeer). Log pressures every run; ambient temp changes require cold adjustment.",
    category: "tyres",
    tags: ["tyre-pressure", "hot", "cold", "graining", "temperature"],
  },
  {
    title: "Brake bias tuning",
    body: "SYMPTOM: Front lockups, rear instability, or long braking distances. FIX: Start at manufacturer's baseline (GT3 ~52-54% front). Move FORWARD if: rear is unstable under braking, locking rears. Move REARWARD if: locking fronts, need shorter stopping distance, want more rotation on entry. Adjust in 0.5-1.0% increments. Wet conditions: move forward 2-3% for stability. As fuel burns off (lighter rear), may need to move forward slightly. This is the highest-leverage in-car adjustment — use it every lap if needed.",
    category: "brakes",
    tags: ["brake-bias", "lockup", "braking", "stability"],
  },
  {
    title: "Brake lockup diagnosis",
    body: "SYMPTOM: Tyres locking under braking; flat-spotting; smoke. FIX: If FRONTS lock: move brake bias rearward 1%, reduce brake pressure/master cylinder, or brake slightly earlier with less peak force. If REARS lock: move bias forward 1-2%, increase engine braking (less coast), or reduce rear brake duct cooling (hotter rears = more grip). Increase ABS 1-2 clicks if available. Check brake temps — cold brakes lock easier; do a proper warm-up lap. Driving: threshold braking — peak force early, then ease off as speed drops (aero grip fades).",
    category: "brakes",
    tags: ["lockup", "brake-bias", "abs", "flat-spot", "braking-technique"],
  },
  {
    title: "Anti-roll bar (ARB) fundamentals",
    body: "STIFFEN front ARB = less front grip = more understeer. SOFTEN front ARB = more front grip = less understeer. STIFFEN rear ARB = less rear grip = more oversteer. SOFTEN rear ARB = more rear grip = less oversteer. ARBs control lateral load transfer: stiffer end takes more load, loses grip first. Use ARBs for balance fine-tuning (1-2 clicks = noticeable). Big balance shifts need springs or aero. Wet: soften both ARBs for more mechanical grip.",
    category: "suspension",
    tags: ["arb", "anti-roll-bar", "balance", "load-transfer"],
  },
  {
    title: "Damper tuning (bump and rebound)",
    body: "BUMP controls compression (hitting a kerb, initial brake dive). REBOUND controls extension (coming off a kerb, throttle pickup). Rule: adjust the END with the problem. Entry understeer on bumps? Soften front bump. Rear kicking over kerbs? Soften rear bump AND rebound. Car slow to take a set? Stiffen rebound slightly. Porpoising/bouncing? Stiffen both bump and rebound on the affected axle. Start from baseline; change 1-2 clicks at a time. Dampers are for TRANSIENTS (kerbs, direction changes) — they don't fix steady-state balance.",
    category: "suspension",
    tags: ["dampers", "bump", "rebound", "kerbs", "transients"],
  },
  {
    title: "Spring rate selection",
    body: "STIFFER springs = less roll/pitch, better aero platform, worse mechanical grip on bumps. SOFTER springs = more mechanical grip, more body movement, aero less stable. Front/rear spring SPLIT controls balance: stiffer front relative to rear = understeer; stiffer rear = oversteer. High-downforce cars need stiff springs to hold the aero platform. Bumpy tracks (Sebring, Nordschleife) need softer springs. Change in 5-10 N/mm increments. Match damper changes to spring changes.",
    category: "suspension",
    tags: ["springs", "spring-rate", "aero-platform", "balance"],
  },
  {
    title: "Camber setup",
    body: "NEGATIVE camber (top of tyre tilts inward) increases cornering grip up to a point. GT3 typical: -3.5° to -4.0° front, -2.5° to -3.0° rear. Too much camber: overheats inside edge, reduces braking grip. Too little: overheats outside edge, poor turn-in. Check tyre temps across the tread: even = correct; hot inside = too much camber; hot outside = too little. More front camber helps turn-in and mid-corner front grip. Rear camber affects traction — less rear camber = better power-down.",
    category: "suspension",
    tags: ["camber", "tyre-temps", "turn-in", "grip"],
  },
  {
    title: "Toe settings",
    body: "FRONT TOE-OUT (wheels point slightly outward): sharper turn-in, more nervous in straight line. FRONT TOE-IN: more stable, duller turn-in. REAR TOE-IN: more rear stability, better traction, slight understeer. REAR TOE-OUT: rotation, but dangerous — avoid. Typical GT3: 0.1-0.2° front toe-out, 0.2-0.4° rear toe-in. Toe affects tyre wear significantly — too much toe = overheating and graining. Small changes (0.05°) are noticeable.",
    category: "suspension",
    tags: ["toe", "turn-in", "stability", "tyre-wear"],
  },
  {
    title: "Ride height and aero balance",
    body: "LOWER ride height = more downforce (until the floor stalls). Front/rear ride height SPLIT (rake) controls aero balance: more rake (rear higher than front) = more front downforce = less understeer. Too low: bottoming, plank wear, diffuser stall (sudden rear grip loss). GT3 typical: 55-65mm front, 65-80mm rear (varies by car). Bumpy tracks: raise 5-10mm. Check plank wear after runs — excessive wear means too low. Ride height is the coarsest aero tool; use wings for fine-tuning.",
    category: "aero",
    tags: ["ride-height", "rake", "downforce", "diffuser", "plank"],
  },
  {
    title: "Wing level selection",
    body: "MORE wing = more downforce = more grip in corners, less top speed. LESS wing = less drag = higher top speed, less cornering grip. Rule of thumb: run as little wing as you can without the car feeling nervous in the fastest corner. High-downforce tracks (Hungaroring, Brands Hatch): max wing. Low-downforce (Monza, Spa): trim it. Balance front/rear wing to maintain aero balance — don't just add rear wing without considering the front. 1 click ≈ 0.1-0.2s on most tracks.",
    category: "aero",
    tags: ["wing", "downforce", "drag", "top-speed", "balance"],
  },
  {
    title: "Differential tuning (power/coast/preload)",
    body: "POWER ramp: controls lock under acceleration. More lock (lower ramp angle) = better traction, more exit understeer. Less lock = more rotation on exit, worse traction. COAST ramp: controls lock off-throttle. More lock = stable entry, less rotation. Less lock = more turn-in rotation, less stable. PRELOAD: baseline lock. More preload = more stable everywhere, less nimble. Start: moderate power lock, moderate coast, low preload. Adjust power for exit issues, coast for entry issues.",
    category: "drivetrain",
    tags: ["differential", "power", "coast", "preload", "traction"],
  },
  {
    title: "Traction control (TC) usage",
    body: "TC cuts power when wheelspin is detected. Higher TC = more intervention = slower but safer. Lower TC = faster if you have the throttle control, but risk of spins. Wet: increase 3-4 clicks. Dry qualifying: run as low as you dare. TC costs time on exit — the fastest drivers use minimal TC. If you're getting power-on oversteer, TC is a band-aid; fix the mechanical balance first, then optimize TC. Some cars have TC maps per corner — use them.",
    category: "electronics",
    tags: ["tc", "traction-control", "wheelspin", "wet"],
  },
  {
    title: "ABS usage and tuning",
    body: "ABS prevents lockups by modulating brake pressure. Higher ABS = more intervention = longer stopping distance but no flat-spots. Lower ABS = shorter stops if you have pedal control, but lockup risk. Wet: increase ABS. Dry: run the minimum you can without locking. ABS is not a substitute for brake bias — get the bias right first. If ABS is constantly active, you're overdriving the braking zone; brake earlier with less peak force.",
    category: "electronics",
    tags: ["abs", "braking", "lockup", "wet"],
  },
  {
    title: "Wet weather setup changes",
    body: "WET SETUP: Soften ARBs 2-3 clicks (more mechanical grip). Raise ride height 5-10mm (aquaplaning resistance). Reduce camber 0.5° (bigger contact patch). Move brake bias forward 2-3%. Increase TC 3-4 clicks, increase ABS 2-3 clicks. Reduce wing? No — keep downforce, you need the grip. Smooth inputs: no sudden steering, progressive throttle/brake. Find the grip off the racing line (rubbered line is slippery when wet).",
    category: "conditions",
    tags: ["wet", "rain", "setup", "tc", "abs", "aquaplaning"],
  },
  {
    title: "Tyre temperature management",
    body: "OPTIMAL: each manufacturer's window (GT3: ~80-100°C core). UNDERHEATED (blue/cold): lack of grip, sliding. Push harder, weave less (weaving doesn't heat cores), check pressures aren't too high. OVERHEATED (red/hot): grip drops off, graining. Reduce aggressive inputs, increase pressures slightly, reduce camber if inner edge hot. IMBALANCE front/rear: adjust pressures or driving style. Surface temp ≠ core temp — IR sensors show surface; the core is what matters for grip. Manage across a stint, not one lap.",
    category: "tyres",
    tags: ["tyre-temp", "overheating", "graining", "management"],
  },
  {
    title: "Fuel load effect on balance",
    body: "FULL TANK: heavier rear, more understeer on entry, more stable. More fuel = slower lap (0.03-0.05s per liter typical). LOW FUEL (qualifying): lighter, more nimble, rear can feel nervous. Setup for the fuel load you'll race: don't qualify on a race setup or vice versa. As fuel burns: rear gets lighter → may need brake bias forward 0.5-1%. Long races: consider starting with slightly more understeer (it'll come toward you as fuel burns).",
    category: "strategy",
    tags: ["fuel", "weight", "balance", "race", "qualifying"],
  },
  {
    title: "Kerb usage technique",
    body: "Kerb strikes upset the car — use them to straighten the line, not as a target. Soften bump 1-2 clicks if the car kicks badly over kerbs. Avoid high/sharp kerbs (sausage kerbs) — they'll launch the car. In the wet, avoid kerbs entirely (painted = ice). If the track has aggressive kerbs you must use, raise ride height 3-5mm to avoid bottoming. Driving: hit kerbs with the car straight, not while turning — the lateral load plus the kerb hit is what spins cars.",
    category: "driving",
    tags: ["kerbs", "technique", "bumps", "wet"],
  },
  {
    title: "Trail braking technique",
    body: "TRAIL BRAKING: carry brake pressure into the corner to keep load on the front tyres for rotation. More trail = more rotation, but risk of entry oversteer. Less trail = more stable, but entry understeer. The fastest technique for most corners. Key: SMOOTH release — don't snap off the brake. Overlap braking with turn-in progressively. If the rear is nervous on entry, reduce trail depth (brake straighter). If the car won't turn, trail deeper. This is a driving technique, not a setup fix — but setup (brake bias, diff coast) can support your trail style.",
    category: "driving",
    tags: ["trail-braking", "technique", "entry", "rotation"],
  },
  {
    title: "Throttle application technique",
    body: "PROGRESSIVE throttle: squeeze it on, don't stab. The grip circle is finite — sudden throttle breaks rear traction. Pick-up point: as you unwind steering, feed in throttle. If you're waiting to get on power (understeer), the car needs setup help OR you're over-slowing entry. Short-shifting (early upshift) can help traction out of slow corners by reducing torque. In the wet: be extra gentle, use a higher gear. TC setting should match your throttle aggression.",
    category: "driving",
    tags: ["throttle", "technique", "traction", "power-on"],
  },
  {
    title: "Sebring specific: bumps and T1",
    body: "SEBRING: Extremely bumpy (concrete sections). Run softer springs and dampers than baseline. Raise ride height 5mm minimum. T1 (Sunset Bend): heavy braking, bumpy entry — brake a touch earlier, stable bias. T13/T15: high-speed, need aero confidence. The concrete patches have different grip — don't chase the perfect line, chase consistency. Tyre pressures: start 0.2 psi lower (bumps generate heat). This track rewards mechanical grip over aero.",
    category: "tracks",
    tags: ["sebring", "bumps", "concrete", "setup"],
  },
  {
    title: "Mosport (CTMP) specific: high-speed commitment",
    body: "MOSPORT: Fast, flowing, old-school. T2 (Clayton Corner): commitment corner — aero balance must be neutral. T5a/b: the esses — need responsive change of direction (stiff enough ARBs). T8/T9: fast downhill — rear stability critical. Don't run max wing; you need straight-line speed for the back straight. Brake bias slightly forward for T8 stability. This track punishes understeer — prioritize front-end response.",
    category: "tracks",
    tags: ["mosport", "ctmp", "high-speed", "aero"],
  },
  {
    title: "Spa-Francorchamps specific: compromise setup",
    body: "SPA: The ultimate compromise. Sector 1/3 need low drag (Kemmel straight). Sector 2 needs downforce (Pouhon, Stavelot). Run medium-low wing — you'll lose in S2 but gain on the straights. Eau Rouge/Raidillon: flat if the car is stable; lift if the rear moves. Brake bias forward for Les Combes. In the wet: Spa is treacherous — maximum caution in S2, the grip varies corner to corner. Fuel: this is a long lap, fuel weight matters.",
    category: "tracks",
    tags: ["spa", "downforce", "compromise", "eau-rouge"],
  },
  {
    title: "Reading telemetry: steering trace",
    body: "STEERING TRACE ANALYSIS: Sawtooth/correction in the trace = driver fighting the car (balance issue or overdriving). Smooth single input = car is balanced, driver is committed. More lock than expected for the speed = understeer. Steering angle increasing through the corner = tightening line, possible exit understeer. Compare to a reference lap: where you add lock, you're losing time. The steering trace is the honesty meter — it shows where the driver doesn't trust the car.",
    category: "telemetry",
    tags: ["telemetry", "steering", "analysis", "understeer"],
  },
  {
    title: "Reading telemetry: throttle/brake overlap",
    body: "THROTTLE/BRAKE ANALYSIS: Overlap (both pressed) = usually a mistake, costs time. Gap between brake release and throttle (coast) = mid-corner; some coast is normal, too much = entry over-slowed. Throttle trace should be smooth ramp, not stab-and-lift (which indicates traction issues). Brake trace: initial hit should be firm, then smooth release. Spikes in the brake trace = ABS intervention or lockup. Compare throttle pickup point corner-to-corner — inconsistency means the balance isn't predictable.",
    category: "telemetry",
    tags: ["telemetry", "throttle", "brake", "analysis"],
  },
];

export default SETUP_KNOWLEDGE;
