# tools/render_free_tier_emulation/Dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY packages/hyperwheel-recommender /app/hyperwheel-recommender
RUN pip install --no-cache-dir -e /app/hyperwheel-recommender

# no persistent volume mounted on purpose - matches Render free tier's
# lack of a persistent disk: anything the process writes (including the
# numba JIT cache) disappears when the container exits.