"""Public-ish game APIs used by the in-browser player (not the develop namespace)."""

from datetime import datetime, timedelta
from typing import Any, Optional

from flask import Blueprint, jsonify, request
from flask_limiter.util import get_remote_address
from flask_login import current_user, login_required
from sqlalchemy import desc, func, or_

from app.extensions import db, limiter
from app.models import Game, GameLike, Scene, Script, Sprite, User, XPLog

api_games_bp = Blueprint("api_games", __name__)

_TIER_WINDOWS = {"small": 60, "medium": 300, "large": 1800}
_TIER_AMOUNTS = {"small": 10, "medium": 25, "large": 75}


def _xp_to_advance_from_level(level: int) -> int:
    """XP required to go from `level` to `level + 1` (100 * level^1.5)."""
    lv = max(1, int(level))
    return int(100 * (lv**1.5))

_PER_PAGE = 20


def _norm_stored_path(value: Optional[str]) -> Optional[str]:
    if value is None or not str(value).strip():
        return None
    return str(value).replace("\\", "/")


def _stored_path_to_public_url(stored_path: Optional[str]) -> Optional[str]:
    if not stored_path or not str(stored_path).strip():
        return None
    s = _norm_stored_path(stored_path)
    if s is None:
        return None
    if s.startswith("/"):
        return s
    if s.startswith("static/"):
        return "/" + s
    return "/static/" + s.lstrip("/")


def _rl_user_key() -> str:
    if current_user.is_authenticated:
        return f"user:{current_user.id}"
    return f"ip:{get_remote_address()}"


def _like_dislike_counts(game_id: int) -> tuple[int, int]:
    likes = (
        db.session.query(func.count(GameLike.user_id))
        .filter(GameLike.game_id == game_id, GameLike.value == 1)
        .scalar()
    )
    dislikes = (
        db.session.query(func.count(GameLike.user_id))
        .filter(GameLike.game_id == game_id, GameLike.value == -1)
        .scalar()
    )
    return int(likes or 0), int(dislikes or 0)


def _batch_like_dislike_counts(
    game_ids: list[int],
) -> dict[int, tuple[int, int]]:
    if not game_ids:
        return {}
    out: dict[int, tuple[int, int]] = {gid: (0, 0) for gid in game_ids}
    rows = (
        db.session.query(GameLike.game_id, GameLike.value, func.count(GameLike.user_id))
        .filter(GameLike.game_id.in_(game_ids), GameLike.value.in_((1, -1)))
        .group_by(GameLike.game_id, GameLike.value)
        .all()
    )
    for gid, val, n in rows:
        likes, dislikes = out[int(gid)]
        c = int(n or 0)
        if int(val) == 1:
            out[int(gid)] = (c, dislikes)
        else:
            out[int(gid)] = (likes, c)
    return out


def _public_list_game_dict(
    game: Game,
    counts: Optional[tuple[int, int]] = None,
    owner_username: Optional[str] = None,
) -> dict[str, Any]:
    likes, dislikes = counts if counts is not None else _like_dislike_counts(game.id)
    return {
        "id": game.id,
        "title": game.title,
        "description": game.description,
        "status": game.status,
        "owner_username": owner_username,
        "play_count": game.play_count,
        "like_count": likes,
        "dislike_count": dislikes,
        "thumbnail_url": _stored_path_to_public_url(game.thumbnail_path),
        "created_at": game.created_at.isoformat() + "Z" if game.created_at else None,
        "updated_at": game.updated_at.isoformat() + "Z" if game.updated_at else None,
    }


@api_games_bp.route("", methods=["GET"])
def api_public_list_games():
    sort = (request.args.get("sort") or "new").strip().lower()
    if sort not in ("new", "trending"):
        return jsonify({"error": 'sort must be "new" or "trending"'}), 400

    raw_q = request.args.get("q", type=str)
    search = raw_q.strip() if raw_q else ""

    page = request.args.get("page", default=1, type=int)
    if page is None or page < 1:
        page = 1

    base = Game.query.filter(Game.status == "public")
    if search:
        pattern = f"%{search}%"
        base = base.filter(
            or_(Game.title.ilike(pattern), Game.description.ilike(pattern))
        )

    total = base.count()

    if sort == "trending":
        cutoff = datetime.utcnow() - timedelta(days=7)
        trend_subq = (
            db.session.query(
                GameLike.game_id,
                func.count(GameLike.user_id).label("trend_score"),
            )
            .filter(
                GameLike.value == 1,
                GameLike.created_at >= cutoff,
            )
            .group_by(GameLike.game_id)
            .subquery()
        )
        query = base.outerjoin(trend_subq, Game.id == trend_subq.c.game_id).order_by(
            desc(func.coalesce(trend_subq.c.trend_score, 0)),
            Game.created_at.desc(),
        )
    else:
        query = base.order_by(Game.created_at.desc())

    rows = query.offset((page - 1) * _PER_PAGE).limit(_PER_PAGE).all()

    batch = _batch_like_dislike_counts([g.id for g in rows])
    owner_ids = list({g.owner_id for g in rows})
    owner_rows = (
        db.session.query(User.id, User.username).filter(User.id.in_(owner_ids)).all()
        if owner_ids
        else []
    )
    owner_map = {int(uid): uname for uid, uname in owner_rows}
    pages = (total + _PER_PAGE - 1) // _PER_PAGE if total else 0
    return (
        jsonify(
            {
                "games": [
                    _public_list_game_dict(
                        g,
                        counts=batch.get(g.id),
                        owner_username=owner_map.get(g.owner_id),
                    )
                    for g in rows
                ],
                "page": page,
                "per_page": _PER_PAGE,
                "total": total,
                "pages": pages,
            }
        ),
        200,
    )


@api_games_bp.route("/<int:game_id>", methods=["GET"])
def api_public_get_game(game_id: int):
    game = db.session.get(Game, game_id)
    if game is None or game.status not in ("public", "unlisted"):
        return jsonify({"error": "Game not found"}), 404

    scenes = (
        Scene.query.filter_by(game_id=game.id)
        .order_by(Scene.order_index.asc(), Scene.id.asc())
        .all()
    )
    scene_payload = []
    for sc in scenes:
        scripts = (
            Script.query.filter_by(scene_id=sc.id)
            .order_by(Script.id.asc())
            .all()
        )
        scene_payload.append(
            {
                "id": sc.id,
                "name": sc.name,
                "order_index": sc.order_index,
                "scripts": [
                    {
                        "id": s.id,
                        "name": s.name,
                        "published_content": s.published_content,
                    }
                    for s in scripts
                ],
            }
        )

    sprites = (
        Sprite.query.filter_by(game_id=game.id).order_by(Sprite.id.asc()).all()
    )
    sprite_payload = [
        {
            "id": sp.id,
            "name": sp.name,
            "published_image_url": _stored_path_to_public_url(
                sp.published_image_path
            ),
        }
        for sp in sprites
    ]

    likes, dislikes = _like_dislike_counts(game.id)
    owner = db.session.get(User, game.owner_id)
    body = {
        "id": game.id,
        "owner_id": game.owner_id,
        "owner_username": owner.username if owner else None,
        "title": game.title,
        "description": game.description,
        "status": game.status,
        "play_count": game.play_count,
        "default_scene_id": game.default_scene_id,
        "like_count": likes,
        "dislike_count": dislikes,
        "thumbnail_url": _stored_path_to_public_url(game.thumbnail_path),
        "created_at": game.created_at.isoformat() + "Z" if game.created_at else None,
        "updated_at": game.updated_at.isoformat() + "Z" if game.updated_at else None,
        "scenes": scene_payload,
        "sprites": sprite_payload,
    }
    return jsonify(body), 200


@api_games_bp.route("/<int:game_id>/play", methods=["POST"])
@limiter.limit("120/minute", key_func=get_remote_address)
def api_public_record_play(game_id: int):
    game = db.session.get(Game, game_id)
    if game is None or game.status not in ("public", "unlisted"):
        return jsonify({"error": "Game not found"}), 404

    db.session.query(Game).filter(Game.id == game_id).update(
        {Game.play_count: Game.play_count + 1},
        synchronize_session=False,
    )
    db.session.commit()
    game = db.session.get(Game, game_id)
    return jsonify({"play_count": int(game.play_count or 0) if game else 0}), 200


@api_games_bp.route("/<int:game_id>/like", methods=["POST"])
@login_required
@limiter.limit("30/minute", key_func=_rl_user_key)
def api_public_like_game(game_id: int):
    game = db.session.get(Game, game_id)
    if game is None or game.status not in ("public", "unlisted"):
        return jsonify({"error": "Game not found"}), 404

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    raw_val = data.get("value")
    if raw_val not in (1, -1):
        return jsonify({"error": 'value must be 1 or -1'}), 400

    row = GameLike.query.filter_by(
        user_id=current_user.id, game_id=game_id
    ).first()
    now = datetime.utcnow()
    if row:
        row.value = int(raw_val)
        row.created_at = now
    else:
        db.session.add(
            GameLike(
                user_id=current_user.id,
                game_id=game_id,
                value=int(raw_val),
                created_at=now,
            )
        )
    db.session.commit()

    likes, dislikes = _like_dislike_counts(game_id)
    return jsonify({"like_count": likes, "dislike_count": dislikes}), 200


@api_games_bp.route("/<int:game_id>/like", methods=["DELETE"])
@login_required
def api_public_unlike_game(game_id: int):
    game = db.session.get(Game, game_id)
    if game is None or game.status not in ("public", "unlisted"):
        return jsonify({"error": "Game not found"}), 404

    GameLike.query.filter_by(user_id=current_user.id, game_id=game_id).delete(
        synchronize_session=False
    )
    db.session.commit()

    likes, dislikes = _like_dislike_counts(game_id)
    return jsonify({"like_count": likes, "dislike_count": dislikes}), 200


@api_games_bp.route("/<int:game_id>/xp", methods=["POST"])
@login_required
def award_game_xp(game_id: int):
    game = db.session.get(Game, game_id)
    if game is None or game.status not in ("public", "unlisted"):
        return jsonify({"error": "Game not found"}), 404

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    raw_tier = body.get("amount", body.get("tier"))
    tier = str(raw_tier or "").lower().strip()
    if tier not in _TIER_AMOUNTS:
        return (
            jsonify(
                {
                    "error": 'amount must be "small", "medium", or "large" '
                    '(alias: tier)'
                }
            ),
            400,
        )

    window_sec = _TIER_WINDOWS[tier]
    cutoff = datetime.utcnow() - timedelta(seconds=window_sec)

    q = (
        db.session.query(XPLog)
        .filter(
            XPLog.user_id == current_user.id,
            XPLog.game_id == game_id,
            XPLog.tier == tier,
            XPLog.awarded_at >= cutoff,
        )
        .order_by(XPLog.awarded_at.desc())
    )
    if q.first():
        return jsonify({"error": "XP rate limit reached"}), 429

    xp_gained = _TIER_AMOUNTS[tier]
    user = db.session.get(User, current_user.id)
    if not user:
        return jsonify({"error": "User not found"}), 401

    user.xp = int(user.xp or 0) + xp_gained
    pixels_gained = 0
    levelled_up = False
    while user.xp >= _xp_to_advance_from_level(user.level):
        need = _xp_to_advance_from_level(user.level)
        user.xp -= need
        user.level = int(user.level or 1) + 1
        pixels_gained += 25 * user.level
        levelled_up = True

    user.pixels = int(user.pixels or 0) + pixels_gained

    log = XPLog(
        user_id=user.id,
        game_id=game_id,
        amount=xp_gained,
        tier=tier,
    )
    db.session.add(log)
    db.session.commit()

    return (
        jsonify(
            {
                "xp_gained": xp_gained,
                "levelled_up": levelled_up,
                "new_level": int(user.level or 1),
                "pixels_gained": pixels_gained,
            }
        ),
        200,
    )
