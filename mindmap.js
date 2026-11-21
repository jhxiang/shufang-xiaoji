// Interactive Character Relationship Mindmap (SVG + Touch/Mouse Drag + Auto Layout + PNG Export)
(() => {
  'use strict';

  const TONE_STYLES = {
    neutral: { color: '#5A738E', dash: '' },
    bond: { color: '#2F8A68', dash: '' },
    love: { color: '#D15B74', dash: '' },
    rival: { color: '#C94B4B', dash: '6,4' },
    mentor: { color: '#C88B2E', dash: '' }
  };

  function ensurePositions(characters) {
    const cx = 260;
    const cy = 175;
    const r = Math.min(125, Math.max(75, characters.length * 22));
    characters.forEach((ch, idx) => {
      if (typeof ch.x !== 'number' || typeof ch.y !== 'number' || Number.isNaN(ch.x) || Number.isNaN(ch.y)) {
        if (characters.length === 1) {
          ch.x = cx;
          ch.y = cy;
        } else {
          const angle = (Math.PI * 2 * idx) / characters.length - Math.PI / 2;
          ch.x = Math.round(cx + r * Math.cos(angle));
          ch.y = Math.round(cy + r * Math.sin(angle));
        }
      }
    });
  }

  function autoLayout(characters) {
    const cx = 260;
    const cy = 175;
    const n = characters.length;
    if (n === 0) return;
    if (n === 1) {
      characters[0].x = cx;
      characters[0].y = cy;
      return;
    }
    const r = n <= 4 ? 105 : Math.min(138, 72 + n * 12);
    characters.forEach((ch, idx) => {
      const angle = (Math.PI * 2 * idx) / n - Math.PI / 2;
      ch.x = Math.round(cx + r * Math.cos(angle));
      ch.y = Math.round(cy + r * Math.sin(angle));
    });
  }

  function createMindmap(container, book, callbacks = {}) {
    const characters = book.characters || [];
    const relations = book.relations || [];
    ensurePositions(characters);

    let scale = 1;
    let panX = 0;
    let panY = 0;
    let draggingId = null;
    let draggingPan = false;
    let dragStart = null;
    let moved = false;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'mindmap-svg');
    svg.setAttribute('viewBox', '0 0 520 350');

    const defs = document.createElementNS(svgNS, 'defs');
    Object.entries(TONE_STYLES).forEach(([tone, st]) => {
      const marker = document.createElementNS(svgNS, 'marker');
      marker.setAttribute('id', `mm-arrow-${tone}`);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', 'M 0 1.5 L 10 5 L 0 8.5 z');
      path.setAttribute('fill', st.color);
      marker.appendChild(path);
      defs.appendChild(marker);
    });
    svg.appendChild(defs);

    const viewportG = document.createElementNS(svgNS, 'g');
    const edgesG = document.createElementNS(svgNS, 'g');
    const nodesG = document.createElementNS(svgNS, 'g');
    viewportG.appendChild(edgesG);
    viewportG.appendChild(nodesG);
    svg.appendChild(viewportG);

    container.innerHTML = '';
    container.appendChild(svg);

    function applyTransform() {
      viewportG.setAttribute('transform', `translate(${panX} ${panY}) scale(${scale})`);
    }

    function clientToSvg(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const vx = ((clientX - rect.left) / rect.width) * 520;
      const vy = ((clientY - rect.top) / rect.height) * 350;
      return { x: (vx - panX) / scale, y: (vy - panY) / scale };
    }

    function render() {
      applyTransform();
      edgesG.innerHTML = '';
      nodesG.innerHTML = '';

      const byId = new Map(characters.map((c) => [c.id, c]));
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const labelBg = isDark ? '#1D2421' : '#FFFFFF';
      const textColor = isDark ? '#ECEEEB' : '#1F2421';

      // Draw edges
      relations.forEach((rel) => {
        const a = byId.get(rel.from);
        const b = byId.get(rel.to);
        if (!a || !b) return;
        const tone = TONE_STYLES[rel.tone] || TONE_STYLES.neutral;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const rNode = 27;
        const x1 = a.x + (dx / dist) * rNode;
        const y1 = a.y + (dy / dist) * rNode;
        const x2 = b.x - (dx / dist) * (rNode + 5);
        const y2 = b.y - (dy / dist) * (rNode + 5);

        const g = document.createElementNS(svgNS, 'g');
        g.style.cursor = 'pointer';

        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('stroke', tone.color);
        line.setAttribute('stroke-width', '2.2');
        if (tone.dash) line.setAttribute('stroke-dasharray', tone.dash);
        line.setAttribute('marker-end', `url(#mm-arrow-${rel.tone || 'neutral'})`);
        g.appendChild(line);

        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const label = rel.label || '关联';
        const pillW = Math.max(36, label.length * 13 + 14);

        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', mx - pillW / 2);
        rect.setAttribute('y', my - 11);
        rect.setAttribute('width', pillW);
        rect.setAttribute('height', 22);
        rect.setAttribute('rx', 11);
        rect.setAttribute('fill', labelBg);
        rect.setAttribute('stroke', tone.color);
        rect.setAttribute('stroke-width', '1.2');
        g.appendChild(rect);

        const txt = document.createElementNS(svgNS, 'text');
        txt.setAttribute('x', mx);
        txt.setAttribute('y', my + 4);
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('font-size', '11');
        txt.setAttribute('font-weight', '700');
        txt.setAttribute('fill', tone.color);
        txt.textContent = label;
        g.appendChild(txt);

        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (callbacks.onEditRelation) callbacks.onEditRelation(rel);
        });
        edgesG.appendChild(g);
      });

      // Draw character nodes
      characters.forEach((ch) => {
        const g = document.createElementNS(svgNS, 'g');
        g.setAttribute('transform', `translate(${ch.x}, ${ch.y})`);
        g.dataset.charId = ch.id;
        g.style.cursor = 'grab';

        const halo = document.createElementNS(svgNS, 'circle');
        halo.setAttribute('r', '28');
        halo.setAttribute('fill', ch.color || '#2F6354');
        halo.setAttribute('opacity', '0.16');
        g.appendChild(halo);

        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('r', '23');
        circle.setAttribute('fill', ch.color || '#2F6354');
        circle.setAttribute('stroke', labelBg);
        circle.setAttribute('stroke-width', '2.5');
        g.appendChild(circle);

        const initial = document.createElementNS(svgNS, 'text');
        initial.setAttribute('y', '5');
        initial.setAttribute('text-anchor', 'middle');
        initial.setAttribute('font-size', '14');
        initial.setAttribute('font-weight', '800');
        initial.setAttribute('fill', '#FFFFFF');
        initial.textContent = (ch.name || '?').slice(0, 2);
        g.appendChild(initial);

        const nameLabel = document.createElementNS(svgNS, 'text');
        nameLabel.setAttribute('y', '41');
        nameLabel.setAttribute('text-anchor', 'middle');
        nameLabel.setAttribute('font-size', '12');
        nameLabel.setAttribute('font-weight', '800');
        nameLabel.setAttribute('fill', textColor);
        nameLabel.textContent = ch.name;
        g.appendChild(nameLabel);

        if (ch.role) {
          const roleLabel = document.createElementNS(svgNS, 'text');
          roleLabel.setAttribute('y', '54');
          roleLabel.setAttribute('text-anchor', 'middle');
          roleLabel.setAttribute('font-size', '10');
          roleLabel.setAttribute('fill', isDark ? '#9BA6A0' : '#717974');
          roleLabel.textContent = ch.role.slice(0, 10);
          g.appendChild(roleLabel);
        }

        nodesG.appendChild(g);
      });
    }

    function onPointerDown(e) {
      const targetNode = e.target.closest('[data-char-id]');
      moved = false;
      if (targetNode) {
        draggingId = targetNode.dataset.charId;
        const pt = clientToSvg(e.clientX, e.clientY);
        const ch = characters.find((c) => c.id === draggingId);
        dragStart = ch ? { ox: ch.x - pt.x, oy: ch.y - pt.y, sx: e.clientX, sy: e.clientY } : null;
      } else {
        draggingPan = true;
        dragStart = { px: panX, py: panY, sx: e.clientX, sy: e.clientY };
      }
      if (svg.setPointerCapture && e.pointerId != null) {
        try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    }

    function onPointerMove(e) {
      if (!dragStart) return;
      if (Math.hypot(e.clientX - dragStart.sx, e.clientY - dragStart.sy) > 4) {
        moved = true;
      }
      if (draggingId) {
        const pt = clientToSvg(e.clientX, e.clientY);
        const ch = characters.find((c) => c.id === draggingId);
        if (ch) {
          ch.x = Math.round(pt.x + dragStart.ox);
          ch.y = Math.round(pt.y + dragStart.oy);
          render();
        }
      } else if (draggingPan) {
        const rect = svg.getBoundingClientRect();
        const dx = ((e.clientX - dragStart.sx) / rect.width) * 520;
        const dy = ((e.clientY - dragStart.sy) / rect.height) * 350;
        panX = dragStart.px + dx;
        panY = dragStart.py + dy;
        applyTransform();
      }
    }

    function onPointerUp() {
      if (draggingId) {
        const ch = characters.find((c) => c.id === draggingId);
        if (moved && callbacks.onPositionsChanged) {
          callbacks.onPositionsChanged();
        } else if (!moved && ch && callbacks.onTapCharacter) {
          callbacks.onTapCharacter(ch);
        }
      }
      draggingId = null;
      draggingPan = false;
      dragStart = null;
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);

    render();

    return {
      zoom(delta) {
        scale = Math.max(0.55, Math.min(2.0, +(scale + delta).toFixed(2)));
        applyTransform();
      },
      resetView() {
        scale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
      },
      relayout() {
        autoLayout(characters);
        scale = 1;
        panX = 0;
        panY = 0;
        render();
        if (callbacks.onPositionsChanged) callbacks.onPositionsChanged();
      },
      exportPngDataUrl(bookTitle = '人物关系图') {
        const canvas = document.createElement('canvas');
        canvas.width = 1040;
        canvas.height = 760;
        const ctx = canvas.getContext('2d');
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        ctx.fillStyle = isDark ? '#141917' : '#F7F4EE';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Header
        ctx.fillStyle = isDark ? '#ECEEEB' : '#1F2421';
        ctx.font = 'bold 28px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(`《${bookTitle}》人物关系思维导图`, 40, 54);
        ctx.fillStyle = isDark ? '#8B9790' : '#7A827D';
        ctx.font = '16px -apple-system, "PingFang SC", sans-serif';
        ctx.fillText('书房小记 · 人物图谱', 40, 82);

        const ox = 0;
        const oy = 60;
        const s = 2;
        const byId = new Map(characters.map((c) => [c.id, c]));

        // Edges
        relations.forEach((rel) => {
          const a = byId.get(rel.from);
          const b = byId.get(rel.to);
          if (!a || !b) return;
          const tone = TONE_STYLES[rel.tone] || TONE_STYLES.neutral;
          const ax = ox + a.x * s;
          const ay = oy + a.y * s;
          const bx = ox + b.x * s;
          const by = oy + b.y * s;

          ctx.save();
          ctx.strokeStyle = tone.color;
          ctx.lineWidth = 3.5;
          if (tone.dash) ctx.setLineDash([10, 7]);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.restore();

          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          const label = rel.label || '关联';
          ctx.font = 'bold 20px -apple-system, "PingFang SC", sans-serif';
          const tw = ctx.measureText(label).width + 24;
          ctx.fillStyle = isDark ? '#1D2421' : '#FFFFFF';
          ctx.strokeStyle = tone.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(mx - tw / 2, my - 18, tw, 36, 18);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = tone.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, mx, my);
        });

        // Nodes
        characters.forEach((ch) => {
          const cx = ox + ch.x * s;
          const cy = oy + ch.y * s;
          ctx.fillStyle = ch.color || '#2F6354';
          ctx.beginPath();
          ctx.arc(cx, cy, 44, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = isDark ? '#141917' : '#FFFFFF';
          ctx.lineWidth = 5;
          ctx.stroke();

          ctx.fillStyle = '#FFFFFF';
          ctx.font = 'bold 26px -apple-system, "PingFang SC", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText((ch.name || '?').slice(0, 2), cx, cy);

          ctx.fillStyle = isDark ? '#ECEEEB' : '#1F2421';
          ctx.font = 'bold 22px -apple-system, "PingFang SC", sans-serif';
          ctx.fillText(ch.name, cx, cy + 68);
        });

        return canvas.toDataURL('image/png');
      }
    };
  }

  window.CharacterMindmap = { createMindmap, autoLayout };
})();
