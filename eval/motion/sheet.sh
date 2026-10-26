#!/bin/bash
# A contact sheet of a recording: 2 frames a second, 8 across, 6 down (24 s a sheet), PREFIX-1.png, PREFIX-2.png …
set -e
ffmpeg -hide_banner -loglevel error -y -i "$1" -vf "fps=2,scale=320:-1,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='%{pts\:hms}':x=4:y=4:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.5,tile=8x6" "$2-%d.png"
