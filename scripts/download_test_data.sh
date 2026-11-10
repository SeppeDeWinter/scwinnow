#!/usr/bin/env bash
# Download the 10x test dataset into data/brain10k/ (resumes partial downloads).
#   10k Human Brain Nuclei, GEM-X Multiome, cellranger-arc 2.2.0: filtered feature-barcode matrix.
set -euo pipefail

DATA_DIR="$(dirname "$0")/../data/brain10k"
BASE=https://cf.10xgenomics.com/samples/cell-arc/2.2.0/10k_Human_Brain_MO_gemx/10k_Human_Brain_MO_gemx
mkdir -p "$DATA_DIR"
for f in filtered_feature_bc_matrix.h5; do
    echo "downloading $f"
    curl -fL --retry 3 -C - -o "$DATA_DIR/$f" "${BASE}_${f}"
done
