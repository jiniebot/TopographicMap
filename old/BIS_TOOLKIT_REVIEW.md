# BIS Toolkit Review

Reviewed commit: `8d7060e94abbeb9a254540c34ad7db97deb64388`

## Packages

| Package | Capability | Relevance to map renderer |
| --- | --- | --- |
| `@bis-toolkit/utils` | Binary reader/writer plus LZO, LZSS, and LZ4 decompression | Foundation for binary asset readers |
| `@bis-toolkit/bcn` | BC1, BC2, BC3, BC4, BC5, and BC7 texture decoding | Converts block-compressed textures to RGBA; BC6H is not implemented |
| `@bis-toolkit/paa` | PAA reader, mipmaps, channel swizzling, and RGBA conversion | Verified against an unpacked DayZ house texture |
| `@bis-toolkit/edds` | EDDS container reader with BC1/2/3 and RGBA/BGRA output | Required for DayZ EDDS textures; narrower codec support than `bcn` |
| `@bis-toolkit/cppparser` | Config/RVMat lexer, parser, preprocessor, typed AST, and `RvmatParser` | Resolves material stages and texture references |
| `@bis-toolkit/p3d` | Editable MLOD P3D reader with LODs, vertices, faces, UVs, and TAGG data | Useful for MLOD inputs, but cannot read vanilla DayZ ODOL models |
| `bis-toolkit` | Namespace-style meta-package for the packages above | Convenience import only |

The repository also includes browser examples for PAA, EDDS, and P3D viewing.
The P3D example contains stale ODOL imports, while the current P3D package and
README explicitly expose MLOD only.

## Verified Against Livonia Assets

- `house_1w03.p3d` is `ODOL` version 54 and therefore unsupported by the
  toolkit's current P3D reader.
- Mikero `DeP3d` identifies 11 LODs, including visual resolutions 1 through 5,
  and reports a 9.05 m by 18.12 m footprint.
- The model's referenced materials, textures, and proxy P3Ds can be enumerated.
- `housev_1i3_mlod_co.paa` successfully decodes through `@bis-toolkit/paa` as
  a 2048x2048 texture with a 16,777,216-byte RGBA buffer.

## Plan Impact

The texture/material portion of the proposed pipeline remains valid. BIS
Toolkit cannot directly parse vanilla DayZ P3Ds at this commit. The pinned
Agentic-Z `dayz-p3d-debin` reader now supplies the missing ODOL v54 to MLOD
bridge. Its converted `house_1w03` was verified by `py3d` and BIS Toolkit: 11
LODs, 61,211 vertices, and 35,775 faces. Mikero `DeP3d` remains useful for
independent inspection and dependency enumeration.
