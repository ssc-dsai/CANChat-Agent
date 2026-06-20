import { useRef, useState } from 'preact/hooks';

interface Props {
  imageUrl: string;
}

export function ImageViewer({ imageUrl }: Props) {
  const [zoom, setZoom] = useState(1);
  const imgRef = useRef<HTMLImageElement>(null);

  return (
    <div class="ws-image-viewer">
      <div class="ws-image-controls">
        <button class="btn btn-small" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button class="btn btn-small" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
        <button class="btn btn-small" onClick={() => setZoom(1)}>Fit</button>
      </div>
      <div class="ws-image-container">
        <img
          ref={imgRef}
          src={imageUrl}
          alt="workspace image"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
}
