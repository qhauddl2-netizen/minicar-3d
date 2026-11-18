"""
타미야 미니4WD (블루/블랙 MANTA RAY 풍) 3D 모델 생성 스크립트.
실행:  blender -b -P build_car.py -- <out.glb> [preview.png]

좌표계: Blender Z-up, 차량 앞쪽 = +Y.  glTF 내보내기 시 앞쪽은 -Z 가 된다.
휠/롤러는 축 중심을 원점으로 하는 Empty 아래에 묶어, 게임에서 회전시킬 수 있게 이름을 붙였다.
  wheel_FL, wheel_FR, wheel_RL, wheel_RR, roller_FL, roller_FR, roller_RL, roller_RR
머티리얼 이름(게임에서 색 교체용): TireBlue, Accent, Chassis, BodyBlack ...
"""
import bpy, bmesh, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "car.glb"
PREVIEW = argv[1] if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------------------------------------------------------------- materials
def mat(name, rgb, metallic=0.0, rough=0.5, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = 1.2
    m.diffuse_color = (*rgb, 1)
    return m


M_CHASSIS = mat("Chassis", (0.010, 0.140, 0.95), 0.0, 0.38)
M_TIRE = mat("TireRubber", (0.012, 0.012, 0.014), 0.0, 0.92)
M_BODY = mat("BodyBlack", (0.012, 0.012, 0.018), 0.25, 0.22)
M_ACCENT = mat("Accent", (0.016, 0.62, 0.52), 0.1, 0.3, emit=(0.0, 0.25, 0.2))
M_CANOPY = mat("Canopy", (0.02, 0.10, 0.12), 0.6, 0.12)
M_WHITE = mat("White", (0.85, 0.85, 0.85), 0.0, 0.4)
M_WHEEL = mat("WheelBlack", (0.62, 0.64, 0.70), 0.85, 0.32)
M_METAL = mat("Metal", (0.55, 0.57, 0.6), 1.0, 0.3)
M_RED = mat("Red", (0.8, 0.02, 0.02), 0.0, 0.4)
M_TREAD = mat("TireTread", (0.030, 0.030, 0.034), 0.0, 0.97)
M_BLUEDECAL = mat("DecalBlue", (0.0, 0.1, 0.8), 0.0, 0.4)


# ---------------------------------------------------------------- helpers
def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def mk_box(name, sx, sy, sz, bevel=0.03):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(sx, sy, sz) * 0.45),
                        segments=3, affect="EDGES")
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.7:
            e.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def finish_ops_obj(name):
    o = bpy.context.object
    o.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def mk_sphere(name, sx, sy, sz, seg=40, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1)
    o = bpy.context.object
    o.scale = (sx, sy, sz)
    return finish_ops_obj(name)


def mk_cyl(name, r, depth, verts=48):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth)
    return finish_ops_obj(name)


def mk_cone(name, r1, r2, depth, verts=40):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth)
    return finish_ops_obj(name)


def mk_torus(name, major, minor, sz=1.0):
    bpy.ops.mesh.primitive_torus_add(major_segments=56, minor_segments=20,
                                     major_radius=major, minor_radius=minor)
    o = bpy.context.object
    o.scale = (1, 1, sz)
    return finish_ops_obj(name)


def put(o, parent, loc, rot=(0, 0, 0), material=None):
    o.parent = parent
    o.location = loc
    o.rotation_euler = rot
    if material:
        o.data.materials.append(material)
    return o


def empty(name, parent, loc):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    link(e)
    e.parent = parent
    e.location = loc
    return e


# ---------------------------------------------------------------- root
car = empty("Car", None, (0, 0, 0))

# ---------------------------------------------------------------- chassis (파란색 샤시)
put(mk_box("chassis_plate", 1.7, 3.5, 0.16, 0.05), car, (0, 0, 0.50), material=M_CHASSIS)
put(mk_box("chassis_front", 2.0, 0.7, 0.30, 0.08), car, (0, 2.0, 0.55), material=M_CHASSIS)
put(mk_box("chassis_rear", 2.0, 0.7, 0.34, 0.08), car, (0, -2.0, 0.58), material=M_CHASSIS)
for s in (-1, 1):
    put(mk_box("rail", 0.30, 3.2, 0.34, 0.07), car, (s * 0.95, 0.0, 0.62), material=M_CHASSIS)
    # 앞/뒤 롤러 스테이
    put(mk_box("stay_f", 0.9, 0.22, 0.12, 0.04), car, (s * 1.55, 1.92, 0.78), material=M_CHASSIS)
    put(mk_box("stay_r", 0.9, 0.22, 0.12, 0.04), car, (s * 1.50, -1.98, 0.80), material=M_CHASSIS)
# 모터/기어 커버
put(mk_box("gearbox", 1.3, 1.1, 0.35, 0.08), car, (0, -0.9, 0.78), material=M_CHASSIS)

# ---------------------------------------------------------------- body (블랙 바디)
put(mk_sphere("shell", 0.86, 1.75, 0.42), car, (0, -0.1, 0.96), material=M_BODY)
nose = mk_cone("nose", 0.55, 0.10, 1.2)
nose.scale = (1.0, 1.0, 1.0)
put(nose, car, (0, 2.05, 0.90), rot=(-math.pi / 2, 0, 0), material=M_BODY)
nose.scale = (1.0, 1.0, 0.55)  # 납작하게 (회전 후 로컬 Y축이 높이)
nose.scale = (1.0, 0.55, 1.0)

put(mk_sphere("canopy", 0.42, 0.78, 0.26), car, (0, 0.38, 1.22), material=M_CANOPY)

for s in (-1, 1):
    # 사이드 포드 + 청록 스트라이프
    put(mk_box("fender", 0.34, 1.6, 0.34, 0.10), car, (s * 0.98, 0.45, 0.80), material=M_BODY)
    put(mk_box("fender_stripe", 0.10, 1.3, 0.06, 0.02), car, (s * 0.98, 0.45, 0.99), material=M_ACCENT)
    put(mk_sphere("stripe", 0.07, 1.6, 0.43), car, (s * 0.30, -0.1, 0.96), material=M_ACCENT)
    # 앞쪽 카나드
    put(mk_box("canard", 0.55, 0.5, 0.05, 0.02), car, (s * 0.80, 1.5, 0.98), rot=(0.25, 0, s * 0.3), material=M_BODY)
    # 뒤쪽 위쪽 윙 스테이
    put(mk_box("wing_stay", 0.10, 0.12, 0.95, 0.03), car, (s * 0.55, -1.55, 1.50), material=M_BODY)
    # 윙 엔드플레이트
    put(mk_box("endplate", 0.07, 1.0, 0.55, 0.03), car, (s * 1.20, -1.70, 1.88), rot=(-0.12, 0, 0), material=M_BODY)

# 리어 윙
put(mk_box("rear_wing", 2.45, 0.95, 0.07, 0.025), car, (0, -1.70, 1.98), rot=(-0.12, 0, 0), material=M_BODY)
put(mk_box("wing_accent", 2.2, 0.08, 0.075, 0.01), car, (0, -2.12, 1.93), rot=(-0.12, 0, 0), material=M_ACCENT)
# 타미야 로고 느낌의 스티커
put(mk_box("decal_w", 0.50, 0.38, 0.012, 0.004), car, (0.82, -1.68, 2.03), rot=(-0.12, 0, 0), material=M_WHITE)
put(mk_box("decal_r", 0.20, 0.14, 0.014, 0.004), car, (0.82, -1.68, 2.034), rot=(-0.12, 0, 0), material=M_RED)
put(mk_box("decal_b", 0.20, 0.14, 0.014, 0.004), car, (0.82, -1.68, 2.036), rot=(-0.12, 0, 0), material=M_BLUEDECAL)

# 앞쪽 세로 윙 (캐노피 위 블레이드)
put(mk_box("blade", 0.08, 1.4, 0.75, 0.03), car, (0, 0.05, 1.62), rot=(0.18, 0, 0), material=M_BODY)
put(mk_box("blade_accent", 0.09, 1.0, 0.07, 0.01), car, (0, 0.05, 1.45), rot=(0.18, 0, 0), material=M_ACCENT)
# 앞쪽 상어 이빨 느낌 (흰색 삼각 스티커)
for i, x in enumerate((-0.25, 0.0, 0.25)):
    t = mk_cone("tooth%d" % i, 0.09, 0.0, 0.3, verts=3)
    put(t, car, (x, 1.52, 0.86), rot=(-math.pi / 2 - 0.35, 0, 0), material=M_WHITE)

# ---------------------------------------------------------------- axles
for y, z in ((1.35, 0.66), (-1.25, 0.76)):
    ax = mk_cyl("axle", 0.07, 2.9)
    put(ax, car, (0, y, z), rot=(0, math.pi / 2, 0), material=M_METAL)


# ---------------------------------------------------------------- wheels (파란 타이어 + 블랙 5스포크 휠)
def make_wheel(name, x, y, r, width):
    w = empty(name, car, (x, y, r))
    minor = 0.17
    major = r - minor
    tire = mk_torus(name + "_tire", major, minor, sz=width / (2 * minor))
    put(tire, w, (0, 0, 0), rot=(0, math.pi / 2, 0), material=M_TIRE)
    rim = mk_torus(name + "_rim", major - minor + 0.03, 0.07, sz=1.6)
    put(rim, w, (0, 0, 0), rot=(0, math.pi / 2, 0), material=M_WHEEL)
    inner = major - minor + 0.05
    for k in range(5):
        a = k * 2 * math.pi / 5
        sp = mk_box(name + "_spoke", 0.12, inner, 0.17, 0.03)
        put(sp, w, (0, math.cos(a) * inner / 2, math.sin(a) * inner / 2), rot=(a - math.pi / 2 + math.pi / 2, 0, 0),
            material=M_WHEEL)
    side = 1 if x > 0 else -1
    for k in range(14):                      # 트레드 돌기: 바퀴가 돌면 눈에 보이도록
        a = k * 2 * math.pi / 14
        lug = mk_box(name + "_lug", width * 0.66, 0.12, 0.20, 0.03)
        put(lug, w, (0, math.cos(a) * (r - 0.06), math.sin(a) * (r - 0.06)), rot=(a, 0, 0), material=M_TREAD)
    for k in range(6):                       # 사이드월 흰색 마크
        a = k * 2 * math.pi / 6 + 0.2
        mk = mk_box(name + "_mark", 0.04, 0.10, 0.26, 0.01)
        put(mk, w, (side * (width / 2 - 0.03), math.cos(a) * (r - 0.19), math.sin(a) * (r - 0.19)), rot=(a, 0, 0), material=M_WHITE)
    hub = mk_cyl(name + "_hub", 0.20, 0.32, verts=24)
    put(hub, w, (0, 0, 0), rot=(0, math.pi / 2, 0), material=M_WHEEL)
    cap = mk_cyl(name + "_cap", 0.09, 0.40, verts=16)
    put(cap, w, (0, 0, 0), rot=(0, math.pi / 2, 0), material=M_METAL)
    return w


make_wheel("wheel_FL", 1.30, 1.35, 0.66, 0.78)
make_wheel("wheel_FR", -1.30, 1.35, 0.66, 0.78)
make_wheel("wheel_RL", 1.32, -1.25, 0.76, 0.80)
make_wheel("wheel_RR", -1.32, -1.25, 0.76, 0.80)


# ---------------------------------------------------------------- rollers (흰색 롤러)
def make_roller(name, x, y, z):
    r = empty(name, car, (x, y, z))
    body = mk_cyl(name + "_body", 0.40, 0.22, verts=40)
    put(body, r, (0, 0, 0), material=M_WHITE)
    ring = mk_torus(name + "_ring", 0.36, 0.05)
    put(ring, r, (0, 0, 0.0), material=M_WHITE)
    bolt = mk_cyl(name + "_bolt", 0.16, 0.30, verts=20)
    put(bolt, r, (0, 0, 0.05), material=M_METAL)
    return r


make_roller("roller_FL", 1.95, 1.92, 0.80)
make_roller("roller_FR", -1.95, 1.92, 0.80)
make_roller("roller_RL", 1.90, -1.98, 0.82)
make_roller("roller_RR", -1.90, -1.98, 0.82)

# 차체/롤러를 낮춰 지면에 붙어 보이게 (바퀴·축은 그대로)
for o in list(bpy.data.objects):
    if o.parent == car and not (o.name.startswith("wheel") or o.name.startswith("axle")):
        o.location.z -= 0.16

# ---------------------------------------------------------------- export
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True,
                          export_cameras=False, export_lights=False, export_yup=True)
print("EXPORTED", OUT)

# ---------------------------------------------------------------- preview render (Workbench)
if PREVIEW:
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 55
    cam = link(bpy.data.objects.new("cam", cam_data))
    cam.location = (-8.5, 8.5, 5.5)
    target = empty("target", None, (0, 0, 0.9))
    c = cam.constraints.new("TRACK_TO")
    c.target = target
    c.track_axis = "TRACK_NEGATIVE_Z"
    c.up_axis = "UP_Y"
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_specular_highlight = True
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (0.8, 0.85, 0.9)
    scene.render.resolution_x = 900
    scene.render.resolution_y = 650
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("PREVIEW", PREVIEW)
