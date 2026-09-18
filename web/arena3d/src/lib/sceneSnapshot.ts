import * as THREE from 'three';

export function installSceneSnapshot(camera: THREE.Camera, scene: THREE.Scene) {
  (window as any).__getSceneSnapshot = () => {
    let meshCount = 0;
    let lightCount = 0;
    const objects: string[] = [];

    scene.traverse((obj) => {
      if ((obj as any).isMesh) {
        meshCount++;
        const m = obj as THREE.Mesh;
        if (objects.length < 30) {
          const pos = m.position;
          const mat = m.material as any;
          objects.push(
            `${m.geometry.type} @ [${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}] ` +
            `color=${mat?.color?.getHexString?.() || '?'} ` +
            `visible=${m.visible}`
          );
        }
      }
      if ((obj as any).isLight) lightCount++;
    });

    return {
      camera: {
        position: camera.position.toArray().map((v: number) => +v.toFixed(2)),
        fov: (camera as any).fov,
      },
      stats: { meshes: meshCount, lights: lightCount },
      objects: objects.slice(0, 20),
      console_errors: (window as any).__consoleErrors || [],
    };
  };

  (window as any).__consoleErrors = [];
  const origError = console.error;
  console.error = (...args) => {
    (window as any).__consoleErrors.push(args.map(String).join(' ').slice(0, 200));
    if ((window as any).__consoleErrors.length > 20) (window as any).__consoleErrors.shift();
    origError(...args);
  };

  console.log('✅ sceneSnapshot installed');
}
