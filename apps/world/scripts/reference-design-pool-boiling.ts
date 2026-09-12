/** Named offline Gorenflo definitions; source version and surface factor belong to each caller. */
export const poolBoilingPython=String.raw`def pressure_factor(p,ctf=True):
    r=p/22.064
    return 1.73*r**.27+6.1*r*r+.68*r*r/(1-r*r if ctf else 1-r)
def pool(p,superheat,ctf=True):
    if superheat<=0:return 0.
    n=.9-.3*(p/22.064)**.15
    return (5600*pressure_factor(p,ctf)*b['surfaceFactor']*superheat/20000**n)**(1/(1-n))
`
