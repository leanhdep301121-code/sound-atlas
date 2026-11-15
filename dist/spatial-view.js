import * as THREE from 'three';
import { OrbitControls } from './assets/vendor/OrbitControls.js';
import { RoomEnvironment } from './assets/vendor/RoomEnvironment.js';

const MODEL_URL = new URL('./assets/model/second-floor.json', import.meta.url);
const MATERIALS_URL = new URL('./assets/materials/materials.json', import.meta.url);
const VIEW_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
const VIEW_RIGHT = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), VIEW_DIRECTION).normalize();
const VIEW_UP = new THREE.Vector3().crossVectors(VIEW_DIRECTION, VIEW_RIGHT).normalize();
const WORK_AREA = new THREE.Box3(new THREE.Vector3(16.8, 0, -21.2), new THREE.Vector3(41.5, 3.2, -2.3));

async function readJson(url, description) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(description + '加载失败，请刷新后重试。');
  try {
    return await response.json();
  } catch {
    throw new Error(description + '格式无法读取，请刷新后重试。');
  }
}

function materialColor(value) {
  if (!Array.isArray(value)) return new THREE.Color(value ?? '#e9e7e1');
  const divisor = Math.max(...value) > 1 ? 255 : 1;
  return new THREE.Color().setRGB(value[0] / divisor, value[1] / divisor, value[2] / divisor, THREE.SRGBColorSpace);
}

function mergeGeometry(records, textureSize) {
  const vertexCount = records.reduce((total, record) => total + record.positions.length / 3, 0);
  const indexCount = records.reduce((total, record) => total + record.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);
  const haveNormals = records.every(record => record.normals?.length === record.positions.length);
  const haveUvs = records.every(record => record.uvs?.length === record.positions.length / 3 * 2);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const record of records) {
    positions.set(record.positions, vertexOffset * 3);
    if (haveNormals) normals.set(record.normals, vertexOffset * 3);
    if (haveUvs) uvs.set(record.uvs, vertexOffset * 2);
    for (const index of record.indices) indices[indexOffset++] = index + vertexOffset;
    vertexOffset += record.positions.length / 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (haveNormals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  if (!haveUvs) {
    const computedNormals = geometry.getAttribute('normal').array;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const [x, y, z] = positions.subarray(offset, offset + 3);
      const nx = Math.abs(computedNormals[offset]);
      const ny = Math.abs(computedNormals[offset + 1]);
      const nz = Math.abs(computedNormals[offset + 2]);
      const horizontal = ny >= Math.max(nx, nz);
      uvs[vertex * 2] = (horizontal || nz >= nx ? x : z) / textureSize[0];
      uvs[vertex * 2 + 1] = (horizontal ? -z : y) / textureSize[1];
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export async function createSpatialView({ container, nodes, onSelect = () => {}, onStatus = () => {}, northBearingDegrees = null, onCompassChange = () => {} }) {
  if (!(container instanceof HTMLElement)) throw new Error('三维视图容器不可用。');
  onStatus('正在加载三维模型与材质…');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    throw new Error('当前浏览器无法启动三维显示，请使用支持 WebGL 的浏览器。');
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f3f4f5');
  const modelGroup = new THREE.Group();
  modelGroup.name = 'Rhino 二层模型';
  scene.add(modelGroup);
  const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, .1, 800);
  camera.position.copy(VIEW_DIRECTION).multiplyScalar(120);
  camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  controls.enableDamping = !reducedMotion.matches;
  controls.dampingFactor = .12;
  controls.minPolarAngle = .03;
  controls.maxPolarAngle = Math.PI / 2 - .06;
  controls.minZoom = .35;
  controls.maxZoom = 12;
  controls.screenSpacePanning = true;
  controls.zoomSpeed = .85;
  controls.rotateSpeed = .65;
  controls.panSpeed = .75;

  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .88;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none' });
  renderer.domElement.setAttribute('aria-label', '二层建筑三维模型，拖动旋转，滚轮缩放，右键平移');
  renderer.domElement.setAttribute('role', 'img');
  container.append(renderer.domElement);

  const markerLayer = document.createElement('div');
  Object.assign(markerLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  container.append(markerLayer);
  const textureCache = new Map();
  const geometryResources = new Set();
  const materialResources = new Set();
  let environmentTarget = null;
  let groundMaterial = null;
  let themeBackground = null;
  let themeGround = null;
  let visible = true;
  let disposed = false;
  let animationFrame = null;
  let currentWidth = 1;
  let currentHeight = 1;
  let currentHeatmap = null;
  let lastHeatmapVersion = null;
  let heatTexture = null;
  let bounds = null;
  let fitted = false;
  let fullFrame = null;
  let framePreset = 'overview';
  let frustumHeight = 40;
  let userNavigated = false;
  const markers = [];
  const projected = new THREE.Vector3();
  const northRadians = Number.isFinite(northBearingDegrees) ? THREE.MathUtils.degToRad(northBearingDegrees) : null;
  const northDirection = northRadians == null ? null : new THREE.Vector3(Math.sin(northRadians), 0, -Math.cos(northRadians));
  const cameraNorth = new THREE.Vector3();
  let lastNorthAngle = null;

  function invalidate() {
    if (disposed || !visible || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(renderFrame);
  }

  function syncTheme() {
    if (disposed) return;
    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue('--scene-background').trim() || '#f3f4f5';
    const ground = styles.getPropertyValue('--scene-ground').trim() || '#e9ecef';
    let changed = false;
    if (background !== themeBackground) {
      scene.background.set(background);
      themeBackground = background;
      changed = true;
    }
    if (groundMaterial && ground !== themeGround) {
      groundMaterial.color.set(ground);
      themeGround = ground;
      changed = true;
    }
    if (changed) invalidate();
  }

  function renderFrame() {
    animationFrame = null;
    if (disposed || !visible) return;
    const moved = controls.update();
    renderer.render(scene, camera);
    if (northDirection) {
      cameraNorth.copy(northDirection).transformDirection(camera.matrixWorldInverse);
      // Camera-local Y points up; CSS rotations are clockwise from screen-up.
      const angle = THREE.MathUtils.radToDeg(Math.atan2(cameraNorth.x, cameraNorth.y));
      if (lastNorthAngle == null || Math.abs(angle - lastNorthAngle) > .05) {
        lastNorthAngle = angle;
        onCompassChange(angle);
      }
    }
    for (const marker of markers) {
      projected.copy(marker.anchor).project(camera);
      const inView = projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1;
      marker.button.hidden = !inView;
      if (!inView) continue;
      marker.button.style.left = ((projected.x + 1) * .5 * currentWidth) + 'px';
      marker.button.style.top = ((1 - projected.y) * .5 * currentHeight) + 'px';
    }
    if (moved && controls.enableDamping) invalidate();
  }
  controls.addEventListener('change', invalidate);
  const startedNavigation = () => { userNavigated = true; };
  controls.addEventListener('start', startedNavigation);

  function projectFrame(box, meshes = null) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const point = new THREE.Vector3();
    const include = (x, y, z) => {
      point.set(x, y, z);
      const horizontal = point.dot(VIEW_RIGHT);
      const vertical = point.dot(VIEW_UP);
      minX = Math.min(minX, horizontal); maxX = Math.max(maxX, horizontal);
      minY = Math.min(minY, vertical); maxY = Math.max(maxY, vertical);
    };
    if (meshes) {
      // Fit the actual silhouette once; the bounding-box corners contain large empty areas.
      for (const mesh of meshes) {
        const vertices = mesh.geometry.getAttribute('position');
        for (let i = 0; i < vertices.count; i += 1) include(vertices.getX(i), vertices.getY(i), vertices.getZ(i));
      }
    } else {
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) include(x, y, z);
    }
    const center = box.getCenter(new THREE.Vector3());
    center.addScaledVector(VIEW_RIGHT, (minX + maxX) / 2 - center.dot(VIEW_RIGHT));
    center.addScaledVector(VIEW_UP, (minY + maxY) / 2 - center.dot(VIEW_UP));
    return { center, width: maxX - minX, height: maxY - minY };
  }

  function updateProjection() {
    const halfHeight = frustumHeight / 2;
    const halfWidth = halfHeight * currentWidth / currentHeight;
    camera.left = -halfWidth; camera.right = halfWidth;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
  }

  function frameCurrentView() {
    if (!bounds) return;
    const workView = framePreset === 'work' || framePreset === 'overview' && currentWidth < 640;
    const frame = workView ? projectFrame(WORK_AREA) : fullFrame;
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    frustumHeight = Math.max(frame.height, frame.width * currentHeight / currentWidth) * 1.12;
    const center = frame.center.clone();
    // Keep mobile work-point labels clear of the right-hand legend in both layers.
    if (workView && currentWidth < 640) center.addScaledVector(VIEW_RIGHT, 44 * frustumHeight / currentHeight);
    camera.zoom = 1;
    updateProjection();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(VIEW_DIRECTION, 120);
    camera.lookAt(center);
    controls.update();
    controls.enableDamping = damping;
    fitted = true;
    userNavigated = false;
    invalidate();
  }

  function resize() {
    if (disposed) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width < 2 || height < 2) return;
    const sizeChanged = currentWidth !== width || currentHeight !== height;
    currentWidth = width;
    currentHeight = height;
    renderer.setSize(width, height, false);
    for (const marker of markers) marker.value.hidden = width < 580;
    if (bounds && (!fitted || sizeChanged && !userNavigated)) frameCurrentView();
    else updateProjection();
    invalidate();
  }

  syncTheme();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  const handleMotion = () => { controls.enableDamping = !reducedMotion.matches; invalidate(); };
  reducedMotion.addEventListener('change', handleMotion);
  const contextLost = event => { event.preventDefault(); onStatus('三维显示暂时中断，请刷新页面重试。'); };
  const contextRestored = () => { renderer.shadowMap.needsUpdate = true; onStatus('拖动旋转，滚轮缩放，右键平移'); invalidate(); };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  renderer.domElement.addEventListener('webglcontextrestored', contextRestored);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    reducedMotion.removeEventListener('change', handleMotion);
    renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
    controls.removeEventListener('change', invalidate);
    controls.removeEventListener('start', startedNavigation);
    controls.dispose();
    for (const geometry of geometryResources) geometry.dispose();
    for (const material of materialResources) material.dispose();
    for (const texture of textureCache.values()) texture.dispose();
    heatTexture?.dispose();
    environmentTarget?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    markerLayer.remove();
  }

  const heatMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: .75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const heatGeometry = new THREE.PlaneGeometry(65, 29);
  const heatPlane = new THREE.Mesh(heatGeometry, heatMaterial);
  heatPlane.rotation.x = -Math.PI / 2;
  heatPlane.position.set(32.5, .025, -14.5);
  heatPlane.visible = false;
  heatPlane.renderOrder = 2;
  scene.add(heatPlane);
  materialResources.add(heatMaterial);
  geometryResources.add(heatGeometry);

  try {
    const [model, textureDefinitions] = await Promise.all([readJson(MODEL_URL, '三维模型'), readJson(MATERIALS_URL, '三维材质')]);
    if (!Array.isArray(model.meshes) || model.meshes.length === 0 || !Array.isArray(model.materials)) throw new Error('三维模型数据不完整。');
    const textureLoader = new THREE.TextureLoader();
    async function loadTexture(path, colorMap = false) {
      if (!path) return null;
      const key = path + (colorMap ? ':color' : ':data');
      if (textureCache.has(key)) return textureCache.get(key);
      const texture = await textureLoader.loadAsync(new URL(path, import.meta.url).href);
      if (disposed) {
        texture.dispose();
        throw new Error('三维视图已关闭。');
      }
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.colorSpace = colorMap ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      textureCache.set(key, texture);
      return texture;
    }

    for (const definition of model.materials) {
      const textureDefinition = textureDefinitions[definition.textureKey] ?? {};
      const useWhitePlaster = definition.textureKey === 'plaster';
      const [map, normalMap, roughnessMap] = await Promise.all([
        loadTexture(useWhitePlaster || definition.useColorMap === false ? null : textureDefinition.colorMap, true),
        loadTexture(textureDefinition.normalMap),
        loadTexture(textureDefinition.roughnessMap),
      ]);
      const opacity = definition.opacity ?? 1;
      const material = new THREE.MeshPhysicalMaterial({
        name: definition.name ?? String(definition.id),
        color: useWhitePlaster ? '#f1efea' : materialColor(definition.color),
        map,
        normalMap,
        roughnessMap,
        normalScale: new THREE.Vector2(...(definition.normalScale ?? textureDefinition.recommendedNormalScale ?? [.2, .2])),
        roughness: definition.roughness ?? textureDefinition.roughness ?? .7,
        metalness: definition.metalness ?? textureDefinition.metalness ?? 0,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
        side: THREE.DoubleSide,
        transmission: opacity < .7 ? .15 : 0,
        ior: 1.48,
        thickness: opacity < .7 ? .025 : 0,
      });
      materialResources.add(material);
      const records = model.meshes.filter(mesh => String(mesh.material) === String(definition.id));
      if (!records.length) continue;
      for (const record of records) {
        if (!Array.isArray(record.positions) || record.positions.length % 3 || !Array.isArray(record.indices) || record.indices.length % 3 || record.indices.some(index => index < 0 || index >= record.positions.length / 3)) throw new Error('三维模型网格索引有误。');
      }
      const geometry = mergeGeometry(records, textureDefinition.physicalSizeMeters ?? [2, 2]);
      geometryResources.add(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = definition.name ?? String(definition.id);
      mesh.castShadow = opacity >= .7;
      mesh.receiveShadow = true;
      modelGroup.add(mesh);
    }
    if (!modelGroup.children.length) throw new Error('三维模型缺少可显示的材质网格。');

    bounds = new THREE.Box3().setFromObject(modelGroup);
    fullFrame = projectFrame(bounds, modelGroup.children);
    const center = bounds.getCenter(new THREE.Vector3());
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    environmentTarget = pmrem.fromScene(room, .04);
    scene.environment = environmentTarget.texture;
    scene.environmentIntensity = .45;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight('#e7edf2', '#bfc3c5', 1.0));
    const sun = new THREE.DirectionalLight('#fffaf2', 2.0);
    sun.position.set(center.x - 22, 55, center.z + 32);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -46, right: 46, top: 40, bottom: -40, near: 1, far: 130 });
    sun.shadow.bias = -.00015;
    sun.shadow.normalBias = .035;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);

    const groundGeometry = new THREE.PlaneGeometry(180, 140);
    groundMaterial = new THREE.MeshStandardMaterial({ color: '#e9ecef', roughness: 1, metalness: 0 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(center.x, bounds.min.y - .025, center.z);
    ground.receiveShadow = true;
    scene.add(ground);
    geometryResources.add(groundGeometry);
    materialResources.add(groundMaterial);
    syncTheme();

    for (const node of nodes) {
      const anchor = new THREE.Vector3((node.cadX - 66000) / 1000, 1.1, -(node.cadY - 131000) / 1000);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'spatial-node-button';
      button.dataset.node = node.id;
      Object.assign(button.style, { position: 'absolute', display: 'flex', alignItems: 'center', gap: '6px', minHeight: '34px', padding: '5px 9px 5px 5px', border: '0', borderRadius: '7px', transform: 'translate(-50%, -100%)', pointerEvents: 'auto', background: 'var(--surface)', color: 'var(--ink)', boxShadow: '0 2px 7px #24344730', whiteSpace: 'nowrap', font: '12px var(--mono)', cursor: 'pointer' });
      const badge = document.createElement('span');
      badge.textContent = node.marker;
      Object.assign(badge.style, { display: 'grid', placeItems: 'center', minWidth: '24px', height: '24px', padding: '0 3px', borderRadius: '4px', background: 'var(--paper)', fontWeight: '600' });
      const value = document.createElement('span');
      value.textContent = '-';
      button.append(badge, value);
      button.addEventListener('click', () => onSelect(node.id));
      markerLayer.append(button);
      markers.push({ node, button, badge, value, anchor });
    }
    renderer.shadowMap.needsUpdate = true;
    resize();
    onStatus('拖动旋转，滚轮缩放，右键平移');
  } catch (error) {
    dispose();
    throw new Error(error.message || '三维视图加载失败，请刷新后重试。');
  }

  function updateHeatmap(canvas,version,opacity=.75){
    if(disposed||!heatPlane.visible||!canvas)return;
    if(currentHeatmap!==canvas){
      heatTexture?.dispose();heatTexture=new THREE.CanvasTexture(canvas);heatTexture.colorSpace=THREE.SRGBColorSpace;
      heatMaterial.map=heatTexture;heatMaterial.needsUpdate=true;currentHeatmap=canvas;lastHeatmapVersion=null;
    }
    if(lastHeatmapVersion!==version){heatTexture.needsUpdate=true;lastHeatmapVersion=version;}
    heatMaterial.opacity=Math.max(0,Math.min(1,opacity));invalidate();
  }

  return {
    setVisible(nextVisible) {
      visible = Boolean(nextVisible);
      controls.enabled = visible;
      if (!visible && animationFrame !== null) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      if (visible) { syncTheme(); resize(); invalidate(); }
    },
    resize,
    updateHeatmap,
    update({ frame, selectedId, layer, heatmapCanvas, heatmapVersion = frame, heatmapOpacity = .75 }) {
      if (disposed) return;
      syncTheme();
      if (!frame) return;
      for (const marker of markers) {
        const { node, button, badge, value } = marker;
        const reading = frame.sound[node.id];
        value.textContent = Number.isFinite(reading) ? reading.toFixed(1) : '无记录';
        const selected = selectedId === node.id;
        button.setAttribute('aria-pressed', selected);
        button.setAttribute('aria-label', node.name + '，' + value.textContent + (Number.isFinite(reading) ? ' dB(A)' : ''));
        button.style.background = selected ? 'var(--accent)' : 'var(--surface)';
        button.style.color = selected ? 'var(--accent-text)' : 'var(--ink)';
        button.style.zIndex = selected ? '2' : '1';
        badge.style.background = selected ? '#ffffff25' : 'var(--paper)';
      }
      heatPlane.visible = layer === 'heatmap' && Boolean(heatmapCanvas);
      if (heatPlane.visible) updateHeatmap(heatmapCanvas,heatmapVersion,heatmapOpacity);
      invalidate();
    },
    zoomBy(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || disposed) return;
      userNavigated = true;
      camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom);
      camera.updateProjectionMatrix();
      controls.update();
      invalidate();
    },
    reset() { framePreset = 'all'; frameCurrentView(); },
    focusWorkArea() { framePreset = 'work'; frameCurrentView(); },
    dispose,
  };
}
