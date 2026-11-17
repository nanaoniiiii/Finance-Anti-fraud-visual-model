"""Strip unused ESP-DL operators and non-INT8 convolution kernels from firmware."""
import argparse
import re
from pathlib import Path
import yaml

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--info',type=Path,required=True)
parser.add_argument('--esp-dl',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
text=args.info.read_text(encoding='utf-8')
ops=sorted(set(re.findall(r'= ([A-Za-z0-9_]+)[(\[]',text)))
types=set(re.findall(r"quant_type = '([^']+)'",text))
if not ops or types-{'S8'}:raise RuntimeError('Expected the tested all-INT8 pose graph')
spec=yaml.safe_load((args.esp_dl/'esp-dl/spec/kernels.yml').read_text())
kernels=[name for name in spec['symbols']if '_s8_'in name]
args.output.write_text('kernel_abi: '+str(spec['kernel_abi'])+'\nops:\n'+''.join('  - '+op+'\n'for op in ops)+'kernels:\n'+''.join('  - '+kernel+'\n'for kernel in kernels),encoding='utf-8')
print('Selected',len(ops),'operators and',len(kernels),'INT8 convolution kernels')
