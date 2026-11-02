# OU-C P1: AP1000 DCD Rev. 19 Tier 2 Figs 4.3-21 (BOL) / 4.3-22 (EOL) moderator temperature coefficient
# (pcm/degF, Doppler excluded) sampled near hot zero power, from KPOST's vector-path extraction
# (lanes/kpost/text/fig21/s{3,4}-paths.json; axis calibration as KPOST's tools/mtc.py). Usage: python3 -I this.py <fig21 dir>
import json, sys
D = sys.argv[1]
def curves(k, x0, x1, X0, X1, y0, y1, Y0, Y1):
    out = []
    for p in json.load(open(f"{D}/s{k}-paths.json")):
        if len(p['pts']) > 8:
            pts = sorted((X0 + (x - x0) / (x1 - x0) * (X1 - X0), Y0 + (y - y0) / (y1 - y0) * (Y1 - Y0)) for x, y in p['pts'])
            out.append(pts)
    return out
def interp(c, x):
    for (a, fa), (b, fb) in zip(c, c[1:]):
        if a <= x <= b:
            return fa + (fb - fa) * (x - a) / (b - a) if b > a else fa
    return None
def integ(c, a, b, n=2000):
    h = (b - a) / n
    return sum(interp(c, a + (i + 0.5) * h) * h for i in range(n))
F21 = curves(3, 145.199, 485.279, 0, 600, 286.679, 613.919, -10, 5)
F22 = curves(4, 115.799, 456.719, 0, 600, 288.479, 621.239, -25, 5)
F21.sort(key=lambda c: interp(c, 557)); F22.sort(key=lambda c: interp(c, 557))
temps = [520, 530, 540, 550, 556.9]
res = {"source": "AP1000 DCD Rev. 19 Tier 2 Section 4.3 (NRC ML11171A445), Figures 4.3-21 (BOL) and 4.3-22 (EOL), pp. 4.3-78/79, vector paths",
       "units": "MTC pcm/degF; integral pcm = -int MTC dT from T to 556.9 F (reactivity added by cooling from HZP to T)"}
for name, cs, borons in (("BOL", F21, [1000, 1500, 2000, 2500]), ("EOL", F22, [0, 500, 1000])):
    res[name] = {}
    for C, c in zip(borons, cs):
        res[name][C] = {"range_F": [round(c[0][0], 1), round(c[-1][0], 1)],
                        "MTC": {str(T): round(interp(c, T), 3) for T in temps},
                        "cooldown_pcm": {str(T): round(-integ(c, T, 556.9), 1) for T in temps[:-1]}}
print(json.dumps(res, indent=1))
