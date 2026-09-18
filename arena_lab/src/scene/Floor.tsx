import { Grid } from '@react-three/drei';

export function Floor() {
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#0a0e1a" metalness={0.6} roughness={0.4} />
      </mesh>
      <Grid
        args={[100, 100]}
        position={[0, 0, 0]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#1e2a4a"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#4dd0ff"
        fadeDistance={50}
        fadeStrength={1}
        infiniteGrid
      />
    </>
  );
}
