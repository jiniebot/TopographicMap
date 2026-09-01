#!/usr/bin/env python3
import json, os, sys

ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
sys.path.insert(0,os.path.join(ROOT,'vendor','Agentic-Z','.claude','skills','dayz-p3d-debin','scripts'))
from bis_reader import BisReader
from odol_reader import ODOL, ODOL_ModelInfo

source=sys.argv[1]
reader=BisReader.from_file(source);ODOL._seek_odol(reader)
if reader.read_ascii(4)!='ODOL':raise ValueError('Not ODOL')
version=reader.read_uint32();reader.version=version;reader.use_lzo=version>=44;reader.use_compression_flag=version>=64
if version>=59:reader.read_uint32()
if version>=58:reader.read_asciiz()
lod_count=reader.read_int32();resolutions=[reader.read_float() for _ in range(lod_count)]
info=ODOL_ModelInfo.read(reader,lod_count)
def vec(v):return {'x':v.x,'y':v.y,'z':v.z}
print(json.dumps({'version':version,'lodCount':lod_count,'resolutions':resolutions,'bboxMin':vec(info.bbox_min_visual),'bboxMax':vec(info.bbox_max_visual),'boundingCenter':vec(info.bounding_center),'boundingSphere':info.bounding_sphere}))
