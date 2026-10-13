"""Derive native 2K runtime copies from licensed originals; never upscale images."""
from pathlib import Path
import hashlib
import json
from PIL import Image

root = Path(__file__).resolve().parents[1] / 'public' / 'textures'
output = root / 'low'
output.mkdir(exist_ok=True)
records = []
for source in sorted(root.iterdir()):
    if source.suffix not in ('.jpg', '.png') or '8k' in source.name or source.name.startswith('earth-detail-'):
        continue
    if source.name in ('surface-material-atlas.jpg', 'centauri-milky-way-4k.jpg'):
        continue
    with Image.open(source) as image:
        if image.width <= 2048:
            continue
        image = image.resize((2048, round(image.height * 2048 / image.width)), Image.Resampling.LANCZOS)
        target = output / source.name
        if source.suffix == '.jpg':
            image.convert('RGB').save(target, quality=88, optimize=True)
        else:
            image.save(target, optimize=True)
    records.append({'file': 'low/' + source.name, 'derivedFrom': source.name,
                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()})
(output / 'provenance.json').write_text(json.dumps({'description': '2K Lanczos runtime copies; original authors and licences in ../provenance.json', 'files': records}, indent=2) + '\n')
print(f'Generated {len(records)} native 2K copies')

(root.parents[1] / 'shared' / 'texture-variants.json').write_text(json.dumps([record['derivedFrom'] for record in records], indent=2) + '\n')
