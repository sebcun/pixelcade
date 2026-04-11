from typing import Optional

from flask import Blueprint, jsonify, redirect, render_template, request, url_for
from flask_limiter.util import get_remote_address
from flask_login import current_user, login_required
from sqlalchemy import func

from app.extensions import db, limiter
from app.models import AvatarItem, Game, GameLike, User, UserAvatarItem

profile_bp = Blueprint("profile", __name__)
api_profile_bp = Blueprint("api_profile", __name__)

_AVATAR_FIELDS = {
    "avatar_base": "base",
    "avatar_eyes": "eyes",
    "avatar_hair": "hair",
    "avatar_accessory": "accessory",
}


def _rl_profile_user_key() -> str:
    if current_user.is_authenticated:
        return f"profile:user:{current_user.id}"
    return f"ip:{get_remote_address()}"


def _serialize_user(user: User) -> dict:
    raw_avatar = user.avatar if isinstance(user.avatar, dict) else {}
    avatar = {
        "base": raw_avatar.get("base"),
        "eyes": raw_avatar.get("eyes"),
        "hair": raw_avatar.get("hair"),
        "accessory": raw_avatar.get("accessory"),
    }
    return {
        "id": user.id,
        "username": user.username,
        "level": int(user.level or 1),
        "xp": int(user.xp or 0),
        "pixels": int(user.pixels or 0),
        "avatar": avatar,
        "created_at": user.created_at.isoformat() + "Z" if user.created_at else None,
    }


def _avatar_layers_from_names(avatar_names: dict) -> dict:
    names = {
        "base": avatar_names.get("base"),
        "eyes": avatar_names.get("eyes"),
        "hair": avatar_names.get("hair"),
        "accessory": avatar_names.get("accessory"),
    }
    wanted = [name for name in names.values() if isinstance(name, str) and name.strip()]
    if not wanted:
        return {k: None for k in names}

    items = AvatarItem.query.filter(AvatarItem.name.in_(wanted)).all()
    image_by_name = {str(item.name): item.image_path for item in items if item.image_path}
    return {k: image_by_name.get(v) if isinstance(v, str) else None for k, v in names.items()}


def _public_game_like_counts(game_ids: list[int]) -> dict[int, int]:
    if not game_ids:
        return {}
    rows = (
        db.session.query(GameLike.game_id, func.count(GameLike.user_id))
        .filter(GameLike.game_id.in_(game_ids), GameLike.value == 1)
        .group_by(GameLike.game_id)
        .all()
    )
    return {int(game_id): int(count or 0) for game_id, count in rows}


def _serialize_public_game(game: Game, like_count: int) -> dict:
    return {
        "id": game.id,
        "title": game.title,
        "description": game.description,
        "thumbnail_path": game.thumbnail_path,
        "play_count": int(game.play_count or 0),
        "like_count": int(like_count or 0),
    }


def _serialize_public_profile(user: User) -> dict:
    games = (
        Game.query.filter_by(owner_id=user.id, status="public")
        .order_by(Game.created_at.desc(), Game.id.desc())
        .all()
    )
    like_counts = _public_game_like_counts([game.id for game in games])
    payload = _serialize_user(user)
    payload["avatar_layers"] = _avatar_layers_from_names(payload.get("avatar", {}))
    payload["games"] = [
        _serialize_public_game(game, like_counts.get(game.id, 0)) for game in games
    ]
    return payload


def _validate_avatar_item(
    user_id: int, category: str, item_name: Optional[str]
) -> tuple[bool, Optional[str]]:
    if item_name is None:
        return True, None
    item = AvatarItem.query.filter_by(category=category, name=item_name).first()
    if item is None:
        return False, f"{category} item '{item_name}' does not exist"
    if item.unlocked_by_default:
        return True, None
    unlocked = UserAvatarItem.query.filter_by(user_id=user_id, item_id=item.id).first()
    if unlocked is None:
        return False, f"{category} item '{item_name}' is not unlocked"
    return True, None


@profile_bp.route("/")
def me():
    if not current_user.is_authenticated:
        return redirect(url_for("main.shell"))
    return redirect(url_for("profile.user", user_id=current_user.username))


@profile_bp.route("/<user_id>")
def user(user_id: str):
    return render_template("profile.html", profile_username=user_id)


@api_profile_bp.route("/<string:username>", methods=["GET"])
def api_get_profile(username: str):
    normalized = username.strip().lower()
    if not normalized:
        return jsonify({"error": "Username is required"}), 400
    user = User.query.filter(func.lower(User.username) == normalized).first()
    if user is None:
        return jsonify({"error": "User not found"}), 404
    return jsonify(_serialize_public_profile(user)), 200


@api_profile_bp.route("/me", methods=["PATCH"])
@login_required
@limiter.limit("20/minute", key_func=_rl_profile_user_key)
def api_patch_me():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    provided = [field for field in _AVATAR_FIELDS if field in data]
    if not provided:
        return jsonify({"error": "No updatable fields provided"}), 400

    for field in provided:
        value = data.get(field)
        if value is not None and not isinstance(value, str):
            return jsonify({"error": f"{field} must be a string or null"}), 400
        if isinstance(value, str) and not value.strip():
            return jsonify({"error": f"{field} must not be empty"}), 400

    user = db.session.get(User, current_user.id)
    if user is None:
        return jsonify({"error": "User not found"}), 404

    for field in provided:
        category = _AVATAR_FIELDS[field]
        raw_value = data.get(field)
        normalized_value = raw_value.strip() if isinstance(raw_value, str) else None
        ok, err = _validate_avatar_item(user.id, category, normalized_value)
        if not ok:
            return jsonify({"error": err, "field": field}), 400

    for field in provided:
        raw_value = data.get(field)
        setattr(user, field, raw_value.strip() if isinstance(raw_value, str) else None)

    db.session.commit()
    return jsonify({"user": _serialize_user(user)}), 200
