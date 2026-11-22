#!/usr/bin/env python3
"""Generate original periodic PBR material data. Requires Python 3 and NumPy.

No input images are edited. All maps are synthesized from shared toroidal
surface fields. Run: python3 source/generate_materials.py --size 2048
"""
from pathlib import Path
import argparse, json, struct, zlib, math
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MATERIALS = [
    dict(id='G01', slug='rally-dirt', name='Rally Dirt', seed=317, tile_m=4.0, relief_m=.035, description='Warm compacted dirt with soft clumps and sparse pale grains.'),
    dict(id='G02', slug='sunlit-sand', name='Sunlit Sand', seed=421, tile_m=4.0, relief_m=.025, description='Golden cream sand with gentle, warped wind ripples. No baked sun lighting.'),
    dict(id='G03', slug='meadow-grass', name='Meadow Grass', seed=557, tile_m=4.0, relief_m=.025, description='Short stylized jade and lime ground cover with broad overlapping blades.'),
    dict(id='G04', slug='lavender-gravel', name='Lavender Gravel', seed=683, tile_m=4.0, relief_m=.055, description='Small lavender-gray and warm cream stones in a muted earth matrix.'),
    dict(id='G05', slug='worn-asphalt', name='Worn Asphalt', seed=829, tile_m=4.0, relief_m=.006, description='Cool slate asphalt with subtle repairs and scattered aggregate. No lane markings.'),
    dict(id='G06', slug='village-cobblestone', name='Village Cobblestone', seed=947, tile_m=4.0, relief_m=.040, description='Irregular interlocking cream and lavender-gray flagstones, with varied sizes and no directional rows.'),
]

def png(path, array, srgb=False):
    """Lossless RGB8 / L8 / L16 PNG with a standard Sub filter."""
    a=np.asarray(array)
    bits=16 if a.dtype==np.uint16 else 8
    channels=1 if a.ndim==2 else a.shape[2]
    assert channels in (1,3) and (bits==8 or channels==1)
    h,w=a.shape[:2]
    raw=np.ascontiguousarray(a.astype('>u2') if bits==16 else a.astype(np.uint8)).view(np.uint8).reshape(h,-1)
    bpp=channels*(bits//8)
    sub=raw.copy()
    sub[:,bpp:]=raw[:,bpp:]-raw[:,:-bpp]
    scan=np.concatenate([np.ones((h,1),dtype=np.uint8),sub],axis=1).tobytes()
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,bits,2 if channels==3 else 0,0,0,0))
    if srgb:data+=chunk(b'sRGB',b'\x00')
    data+=chunk(b'IDAT',zlib.compress(scan,6))+chunk(b'IEND',b'')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(data)

def read_png(path):
    data=path.read_bytes(); pos=8; payload=b''; srgb=False
    assert data[:8]==b'\x89PNG\r\n\x1a\n'
    while pos<len(data):
        n=struct.unpack('>I',data[pos:pos+4])[0];kind=data[pos+4:pos+8];block=data[pos+8:pos+8+n]
        assert zlib.crc32(kind+block)&0xffffffff==struct.unpack('>I',data[pos+8+n:pos+12+n])[0]
        if kind==b'IHDR':w,h,bits,color,*_=struct.unpack('>IIBBBBB',block)
        elif kind==b'IDAT':payload+=block
        elif kind==b'sRGB':srgb=True
        pos+=n+12
    channels=3 if color==2 else 1;bpp=channels*bits//8
    scan=np.frombuffer(zlib.decompress(payload),np.uint8).reshape(h,1+w*bpp)
    assert np.all(scan[:,0]==1)
    raw=np.empty((h,w*bpp),np.uint8)
    for i in range(bpp):raw[:,i::bpp]=(np.cumsum(scan[:,1+i::bpp],axis=1,dtype=np.uint32)&255).astype(np.uint8)
    a=raw.copy().view('>u2').astype(np.uint16) if bits==16 else raw
    return a.reshape((h,w,channels) if channels==3 else (h,w)),srgb

def smooth(a,b,x):
    t=np.clip((x-a)/(b-a),0,1)
    return t*t*(3-2*t)

def color(hexcode):
    return np.array([int(hexcode[i:i+2],16) for i in (1,3,5)],np.float32)/255

def mix(a,b,t):
    return a+(b-a)*t[...,None]

def noise(size,cells,seed):
    """C2 smooth periodic value noise; sample centers, no duplicated edge texel."""
    rng=np.random.default_rng(seed)
    grid=rng.random((cells,cells),dtype=np.float32)
    p=(np.arange(size,dtype=np.float32)+.5)*cells/size
    index=np.floor(p).astype(int); t=p-index
    t=(t*t*t*(t*(t*6-15)+10)).astype(np.float32)
    a=grid[index[:,None]%cells,index[None,:]%cells]
    b=grid[index[:,None]%cells,(index[None,:]+1)%cells]
    c=grid[(index[:,None]+1)%cells,index[None,:]%cells]
    d=grid[(index[:,None]+1)%cells,(index[None,:]+1)%cells]
    top=a+(b-a)*t[None,:];bottom=c+(d-c)*t[None,:]
    return top+(bottom-top)*t[:,None]

def organic_noise(size,frequency,seed):
    """Isotropic periodic spectral field; no interpolated square lattice cells."""
    grid_size=min(size,max(32,2**math.ceil(math.log2(frequency*6))))
    rng=np.random.default_rng(seed)
    white=rng.standard_normal((grid_size,grid_size)).astype(np.float32)
    frequencies=np.fft.fftshift(np.fft.fftfreq(grid_size)*grid_size)
    k2=frequencies[:,None]**2+frequencies[None,:]**2
    spectrum=np.fft.fftshift(np.fft.fft2(white))
    spectrum*=np.exp(-k2/(2*frequency**2))
    spectrum[grid_size//2,grid_size//2]=0
    # Remove the unpaired Nyquist row/column before zero-padding.
    spectrum[0,:]=0;spectrum[:,0]=0
    padded=np.zeros((size,size),np.complex128)
    start=(size-grid_size)//2
    padded[start:start+grid_size,start:start+grid_size]=spectrum
    field=np.fft.ifft2(np.fft.ifftshift(padded)).real.astype(np.float32)
    field/=max(float(field.std()),1e-8)
    return (.5+.24*np.tanh(field*.65)).astype(np.float32)

def cobbles(size,seed,broad,fine):
    """Irregular inset Voronoi flagstones on a torus, with no rows or grain direction."""
    rng=np.random.default_rng(seed)
    sites=[]
    # Random rejection sampling keeps useful stone sizes without imposing a lattice.
    while len(sites)<245:
        candidate=rng.random(2)
        if sites:
            delta=(np.asarray(sites)-candidate+.5)%1-.5
            if np.min(np.sum(delta*delta,axis=1))<.031**2:continue
        sites.append(candidate)
    sites=np.asarray(sites)
    detail=organic_noise(size,95,seed+21)
    wear=organic_noise(size,28,seed+22)
    height=(.05+.018*detail).astype(np.float32)
    albedo=mix(color('#8D8780'),color('#A29A8E'),.6*fine+.4*broad)
    rough=np.full((size,size),.94,np.float32)
    palette=np.array([color('#B8ADA4'),color('#C8BBA7'),color('#ADA7B4'),color('#A5A1AF'),color('#C1B4AB'),color('#BAB6BE')])
    for i,center in enumerate(sites):
        delta=(sites-center+.5)%1-.5
        distances=np.sum(delta*delta,axis=1)
        neighbors=np.argsort(distances)[1:35]
        poly=np.array([[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]])
        # Clip the local Voronoi cell by perpendicular bisectors of nearby sites.
        for j in neighbors:
            normal=delta[j];limit=distances[j]*.5
            out=[]
            for k,point in enumerate(poly):
                nxt=poly[(k+1)%len(poly)]
                da=np.dot(point,normal)-limit;db=np.dot(nxt,normal)-limit
                if da<=0:out.append(point)
                if (da<=0)!=(db<=0):out.append(point+(nxt-point)*da/(da-db))
            poly=np.array(out)
        lo=np.floor((poly.min(axis=0)+center)*size).astype(int)-1
        hi=np.ceil((poly.max(axis=0)+center)*size).astype(int)+1
        xs=np.arange(lo[0],hi[0]+1);ys=np.arange(lo[1],hi[1]+1)
        x=(xs[None,:]+.5)/size-center[0];y=(ys[:,None]+.5)/size-center[1]
        edge_distance=np.full((len(ys),len(xs)),np.inf,np.float32)
        for k,point in enumerate(poly):
            edge=poly[(k+1)%len(poly)]-point
            signed=(edge[0]*(y-point[1])-edge[1]*(x-point[0]))/np.linalg.norm(edge)
            edge_distance=np.minimum(edge_distance,signed)
        idx=np.ix_(ys%size,xs%size)
        # Small edge variation and a rounded shoulder soften the polygon geometry.
        d=edge_distance+(detail[idx]-.5)*.003
        inset=rng.uniform(.0025,.0038)
        mask=smooth(inset,inset+.0015,d)
        shoulder=smooth(inset,inset+.008,d)
        lift=rng.uniform(.60,.87)
        relief=.05+mask*(.12+lift*.72*shoulder+.035*(wear[idx]-.5)+.018*(detail[idx]-.5))
        height[idx]=np.maximum(height[idx],relief)
        tone=palette[rng.integers(len(palette))]*rng.uniform(.97,1.03)
        stone=tone*(.97+.06*wear[idx][...,None])
        albedo[idx]=albedo[idx]*(1-mask[...,None])+stone*mask[...,None]
        stone_rough=rng.uniform(.73,.86)+.04*(detail[idx]-.5)
        rough[idx]=rough[idx]*(1-mask)+stone_rough*mask
    return albedo.astype(np.float32),height.astype(np.float32),rough.astype(np.float32)

def stone_stamps(height,albedo,rough,size,seed,count,radius_px,palette,amplitude):
    """Original polygonal stone fields stamped on a torus, including wrapped edges."""
    rng=np.random.default_rng(seed)
    for _ in range(count):
        cx,cy=rng.uniform(0,size,2);radius=rng.uniform(*radius_px)
        stretch=rng.uniform(.65,1.25);phase=rng.uniform(0,2*np.pi)
        extent=int(math.ceil(radius*1.5))+1
        xs=np.arange(math.floor(cx)-extent,math.floor(cx)+extent+1)
        ys=np.arange(math.floor(cy)-extent,math.floor(cy)+extent+1)
        dx=(xs[None,:]+.5-cx)/radius;dy=(ys[:,None]+.5-cy)/(radius*stretch)
        angle=np.arctan2(dy,dx)
        radial=np.sqrt(dx*dx+dy*dy)/(1+.12*np.cos(5*angle+phase)+.07*np.sin(3*angle-phase))
        edge=1-smooth(.82,1.02,radial)
        cap=np.clip(1-radial*.72,0,1)*edge
        idx=np.ix_(ys%size,xs%size)
        old=height[idx]
        level=.27+cap*amplitude*rng.uniform(.65,1.05)
        height[idx]=(old+(np.maximum(old,level)-old)*edge).astype(np.float32)
        tone=palette[int(rng.integers(len(palette)))]
        blend=(edge*.92).astype(np.float32)
        albedo[idx]=albedo[idx]*(1-blend[...,None])+tone*blend[...,None]
        rough[idx]=rough[idx]*(1-blend)+rng.uniform(.72,.91)*blend

def grass_stamps(height,albedo,size,seed):
    rng=np.random.default_rng(seed)
    tones=[color('#4D883D'),color('#639B43'),color('#79AC46'),color('#8AB94D'),color('#3F7F42')]
    for _ in range(4600):
        cx,cy=rng.uniform(0,size,2);length=rng.uniform(.014,.041)*size;width=rng.uniform(.0025,.0065)*size
        angle=rng.uniform(0,2*np.pi);extent=int(length+width)+2
        xs=np.arange(math.floor(cx)-extent,math.floor(cx)+extent+1)
        ys=np.arange(math.floor(cy)-extent,math.floor(cy)+extent+1)
        dx=xs[None,:]+.5-cx;dy=ys[:,None]+.5-cy
        along=(dx*np.cos(angle)+dy*np.sin(angle))/length
        across=(dy*np.cos(angle)-dx*np.sin(angle))/width
        arc=across-.5*np.sin(np.pi*along)
        shape=np.sqrt((along/.95)**2+arc**2)
        leaf=(1-smooth(.65,1.05,shape)).astype(np.float32)
        ridge=(1-np.clip(np.abs(arc),0,1))*.12
        idx=np.ix_(ys%size,xs%size)
        old=height[idx]
        height[idx]=(old+(np.maximum(old,.35+leaf*(.30+ridge))-old)*leaf).astype(np.float32)
        blend=leaf*.58
        tone=tones[int(rng.integers(len(tones)))]
        albedo[idx]=albedo[idx]*(1-blend[...,None])+tone*blend[...,None]

def surfaces(m,n):
    seed=m['seed']
    broad=organic_noise(n,3.5,seed);medium=organic_noise(n,15,seed+1);fine=noise(n,120,seed+2);micro=noise(n,400,seed+3)
    if m['slug']=='rally-dirt':
        t=np.clip(.3+.25*broad+.3*medium+.15*fine,0,1)
        albedo=mix(color('#AF7B46'),color('#C49457'),t)
        height=.15+.26*medium+.08*fine+.015*micro
        rough=.82+.13*medium
        stone_stamps(height,albedo,rough,n,seed+10,420,(n*.0018,n*.006),[color('#C7AA7F'),color('#B49165'),color('#D4B887')],.18)
    elif m['slug']=='sunlit-sand':
        u=(np.arange(n,dtype=np.float32)+.5)[None,:]/n;v=(np.arange(n,dtype=np.float32)+.5)[:,None]/n
        phase=2*np.pi*(13*v+.7*np.sin(2*np.pi*2*u)+.22*np.sin(2*np.pi*(u+v)))
        wave=(.5+.5*np.cos(phase))**1.4
        height=.15+.18*broad+.23*wave+.035*fine+.012*micro
        albedo=mix(color('#D6B779'),color('#EDD5A0'),.60*broad+.28*medium+.12*fine)
        rough=.83+.12*fine
    elif m['slug']=='meadow-grass':
        albedo=mix(color('#3E7942'),color('#7EA84D'),.65*broad+.35*medium)
        height=.18+.16*medium+.04*fine
        rough=.83+.12*medium
        grass_stamps(height,albedo,n,seed+10)
    elif m['slug']=='lavender-gravel':
        albedo=mix(color('#8C827B'),color('#A29B90'),medium)
        height=.12+.08*medium+.015*fine
        rough=.87+.09*fine
        stone_stamps(height,albedo,rough,n,seed+10,2100,(n*.0035,n*.013),[color('#A09AB5'),color('#8C88A1'),color('#B6AEC3'),color('#C7BBA8'),color('#C5B9A1'),color('#8F91A6')],.51)
    elif m['slug']=='worn-asphalt':
        patches=smooth(.25,.80,broad)
        albedo=mix(color('#4C5667'),color('#5A6475'),.25*patches+.45*medium+.30*fine)
        height=.25+.035*medium+.045*fine+.025*micro
        rough=.76+.16*medium+.035*fine
        stone_stamps(height,albedo,rough,n,seed+10,4800,(n*.0007,n*.0024),[color('#79818D'),color('#626E80'),color('#8C929B')],.075)
    else:
        albedo,height,rough=cobbles(n,seed+10,broad,fine)
    height=height.astype(np.float32)
    height=(height-height.min())/(height.max()-height.min())
    return np.clip(albedo,0,1).astype(np.float32),height,np.clip(rough,0,1).astype(np.float32)

def maps_from_fields(m,albedo,height,rough):
    n=height.shape[0];pixel_m=m['tile_m']/n
    physical=height*m['relief_m']
    dx=(np.roll(physical,-1,1)-np.roll(physical,1,1))/(2*pixel_m)
    dy_down=(np.roll(physical,-1,0)-np.roll(physical,1,0))/(2*pixel_m)
    # OpenGL +Y points toward increasing V/up in the displayed image.
    normal=np.stack([-dx,dy_down,np.ones_like(height)],axis=-1)
    normal/=np.sqrt((normal*normal).sum(axis=-1,keepdims=True))
    cavity=np.zeros_like(height)
    for radius in (max(1,n//256),max(2,n//96),max(3,n//40)):
        mean=(np.roll(height,radius,0)+np.roll(height,-radius,0)+np.roll(height,radius,1)+np.roll(height,-radius,1))/4
        cavity=np.maximum(cavity,mean-height)
    ao=np.clip(1-cavity*.70,.72,1)
    u8=lambda a:np.rint(np.clip(a,0,1)*255).astype(np.uint8)
    normal_gl=u8(normal*.5+.5)
    normal_dx=normal_gl.copy();normal_dx[...,1]=255-normal_dx[...,1]
    rough8=u8(rough);ao8=u8(ao)
    return {'basecolor':u8(albedo),'normal_gl':normal_gl,'normal_dx':normal_dx,'roughness':rough8,'height':np.rint(height*65535).astype(np.uint16),'ao':ao8,'orm':np.stack([ao8,rough8,np.zeros_like(ao8)],axis=-1)}

def seam_metrics(a):
    """Seam neighbor differences compared with every other adjacent pixel."""
    x=a.astype(np.float32)/((65535.) if a.dtype==np.uint16 else 255.)
    if x.ndim==2:x=x[...,None]
    interior=np.concatenate([np.abs(np.diff(x,axis=0)).reshape(-1),np.abs(np.diff(x,axis=1)).reshape(-1)])
    seam=np.concatenate([np.abs(x[0]-x[-1]).reshape(-1),np.abs(x[:,0]-x[:,-1]).reshape(-1)])
    return dict(interior_mean=float(interior.mean()),seam_mean=float(seam.mean()),mean_ratio=float(seam.mean()/max(interior.mean(),1e-8)),interior_p99=float(np.quantile(interior,.99)),seam_p99=float(np.quantile(seam,.99)))

def generate(size):
    validation={'method':'Original toroidal surface fields, wrap-aware normals and cavity; PNG round-trip and cross-map checks.', 'materials':{}}
    for m in MATERIALS:
        print('Generating '+m['name'],flush=True)
        albedo,height,rough=surfaces(m,size)
        maps=maps_from_fields(m,albedo,height,rough)
        folder=ROOT/m['slug'];folder.mkdir(exist_ok=True)
        stats={}
        for name,array in maps.items():
            path=folder/(name+'.png');png(path,array,srgb=name=='basecolor')
            decoded,srgb=read_png(path)
            assert np.array_equal(decoded,array),path
            assert srgb==(name=='basecolor')
            stats[name]=seam_metrics(array)
            assert stats[name]['mean_ratio']<2.0,(m['slug'],name,stats[name])
        assert np.array_equal(maps['orm'][...,0],maps['ao'])
        assert np.array_equal(maps['orm'][...,1],maps['roughness'])
        assert not np.any(maps['orm'][...,2])
        assert np.array_equal(maps['normal_dx'][...,1],255-maps['normal_gl'][...,1])
        decoded_n=maps['normal_gl'].astype(np.float32)/255*2-1
        unit_error=float(np.max(np.abs(np.linalg.norm(decoded_n,axis=-1)-1)))
        assert unit_error<.008
        # Deliberately simple overview samples, generated directly from fields.
        step=max(1,size//512)
        png(folder/'swatch.png',maps['basecolor'][::step,::step],True)
        sw=maps['basecolor'][::step,::step]
        png(folder/'repeat-2x2.png',np.tile(sw,(2,2,1)),True)
        metadata={**m,'resolution':[size,size],'workflow':'metallic-roughness','metallic':0,'normal_conventions':{'normal_gl.png':'OpenGL +Y, V increases up; G=0.5+0.5*dH/dImageDown before normalization','normal_dx.png':'DirectX -Y; identical except inverted green channel'},'height_encoding':{'format':'16-bit grayscale PNG, linear','black_m':0,'white_m':m['relief_m'],'suggested_midpoint':.5,'note':'Relative artistic microrelief. Not a measured terrain elevation or collision map.'},'maps':{name:{'file':name+'.png','color_space':'sRGB' if name=='basecolor' else 'linear / non-color','bit_depth':16 if name=='height' else 8} for name in maps},'orm_channels':{'R':'approximate cavity AO','G':'roughness','B':'metallic (zero)'},'ao_note':'Local cavity approximation from height; not a ray-traced ambient-occlusion bake.','tiling':'Seamless periodic XY. Sample centers; no duplicated border texels. Repeat wrap mode.','provenance':'Original procedural synthesis; no external images or photogrammetry. All maps share one surface field.','source':'../source/generate_materials.py'}
        (folder/'material.json').write_text(json.dumps(metadata,indent=2)+'\n')
        validation['materials'][m['slug']]={'map_checks':stats,'maximum_normal_unit_error':unit_error,'png_roundtrip':'passed','orm_alignment':'passed','dx_gl_green_flip':'passed'}
        print('  7 maps + previews verified',flush=True)
    (ROOT/'validation.json').write_text(json.dumps(validation,indent=2)+'\n')
    (ROOT/'manifest.json').write_text(json.dumps({'version':'1.2','resolution':[size,size],'materials':MATERIALS},indent=2)+'\n')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--size',type=int,default=2048)
    args=parser.parse_args();assert args.size>=256 and args.size&(args.size-1)==0
    generate(args.size)
