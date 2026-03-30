import shutil
from pathlib import Path
from typing import Any, Optional

from flask import Blueprint, current_app, jsonify, request
from flask_login import current_user, login_required
from flask_limiter.util import get_remote_address
from sqlalchemy import func
from werkzeug.utils import secure_filename

from app.extensions import db, limiter
from app.models import Game, GameLike, GamePurchase, Scene, Script, Sprite, XPLog

develop_bp = Blueprint("develop", __name__)
api_develop_bp = Blueprint("api_develop", __name__)

ALLOWED_STATUSES = frozenset({"private", "unlisted", "public"})

SPRITE_PNG_MAX_BYTES = 50 * 1024
SPRITE_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _rl_user_key() -> str:
    if current_user.is_authenticated:
        return f"user:{current_user.id}"
    return f"ip:{get_remote_address()}"


def _game_to_dict(game: Game) -> dict[str, Any]:
    return {
        "id": game.id,
        "owner_id": game.owner_id,
        "title": game.title,
        "description": game.description,
        "status": game.status,
        "play_count": game.play_count,
        "thumbnail_path": game.thumbnail_path,
        "max_scenes": game.max_scenes,
        "max_sprites": game.max_sprites,
        "max_scripts_per_scene": game.max_scripts_per_scene,
        "created_at": game.created_at.isoformat() + "Z" if game.created_at else None,
        "updated_at": game.updated_at.isoformat() + "Z" if game.updated_at else None,
    }


def _is_blank(value: Optional[str]) -> bool:
    if value is None:
        return True
    if not isinstance(value, str):
        return True
    return len(value.strip()) == 0


def _status_allows_visibility(status: str) -> bool:
    return status in ("unlisted", "public")


def _reject_if_visibility_without_copy(title: Optional[str], description: Optional[str], status: str):
    if _status_allows_visibility(status) and (_is_blank(title) or _is_blank(description)):
        return (
            jsonify(
                {
                    "error": "Title and description are required for unlisted or public games",
                }
            ),
            400,
        )
    return None


def _project_root() -> Path:
    return Path(current_app.root_path).resolve().parent


def _resolve_under_project_root(stored_path: Optional[str]) -> Optional[Path]:
    if not stored_path or not str(stored_path).strip():
        return None
    root = _project_root()
    raw = Path(stored_path)
    path = (root / raw).resolve() if not raw.is_absolute() else raw.resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


def _delete_stored_file(stored_path: Optional[str]) -> None:
    path = _resolve_under_project_root(stored_path)
    if path is None or not path.is_file():
        return
    path.unlink()


def _get_owned_game(game_id: int) -> tuple[Optional[Game], Optional[tuple[Any, int]]]:
    game = db.session.get(Game, game_id)
    if game is None:
        return None, (jsonify({"error": "Game not found"}), 404)
    if game.owner_id != current_user.id:
        return None, (jsonify({"error": "Forbidden"}), 403)
    return game, None


def _get_scene_for_game(
    game: Game, scene_id: int
) -> tuple[Optional[Scene], Optional[tuple[Any, int]]]:
    scene = db.session.get(Scene, scene_id)
    if scene is None or scene.game_id != game.id:
        return None, (jsonify({"error": "Scene not found"}), 404)
    return scene, None


def _get_script_for_scene(
    scene: Scene, script_id: int
) -> tuple[Optional[Script], Optional[tuple[Any, int]]]:
    script = db.session.get(Script, script_id)
    if script is None or script.scene_id != scene.id:
        return None, (jsonify({"error": "Script not found"}), 404)
    return script, None


def _get_sprite_for_game(
    game: Game, sprite_id: int
) -> tuple[Optional[Sprite], Optional[tuple[Any, int]]]:
    sprite = db.session.get(Sprite, sprite_id)
    if sprite is None or sprite.game_id != game.id:
        return None, (jsonify({"error": "Sprite not found"}), 404)
    return sprite, None


def _norm_stored_path(value: Optional[str]) -> Optional[str]:
    if value is None or not str(value).strip():
        return None
    return str(value).replace("\\", "/")


def _sprite_has_unpublished_changes(sprite: Sprite) -> bool:
    pub = _norm_stored_path(sprite.published_image_path)
    if pub is None:
        return True
    draft = _norm_stored_path(sprite.draft_image_path)
    return draft != pub


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


def _sprite_to_api_dict(sprite: Sprite) -> dict[str, Any]:
    return {
        "id": sprite.id,
        "name": sprite.name,
        "draft_image_url": _stored_path_to_public_url(sprite.draft_image_path),
        "published_image_url": _stored_path_to_public_url(sprite.published_image_path),
        "has_unpublished_changes": _sprite_has_unpublished_changes(sprite),
    }


def _script_has_unpublished_changes(script: Script) -> bool:
    if script.published_content is None:
        return True
    return script.draft_content != script.published_content


def _scene_to_dict(scene: Scene) -> dict[str, Any]:
    return {
        "id": scene.id,
        "game_id": scene.game_id,
        "name": scene.name,
        "order_index": scene.order_index,
    }


def _script_to_list_item(script: Script) -> dict[str, Any]:
    return {
        "id": script.id,
        "name": script.name,
        "draft_content": script.draft_content,
        "has_unpublished_changes": _script_has_unpublished_changes(script),
    }


def _script_to_mutation_response(script: Script) -> dict[str, Any]:
    out = _script_to_list_item(script)
    out["scene_id"] = script.scene_id
    out["created_at"] = script.created_at.isoformat() + "Z" if script.created_at else None
    out["updated_at"] = script.updated_at.isoformat() + "Z" if script.updated_at else None
    return out


def _parse_optional_string(data: dict, key: str) -> tuple[Optional[str], Optional[tuple[Any, int]]]:
    if key not in data:
        return None, None
    val = data[key]
    if val is None:
        return None, None
    if not isinstance(val, str):
        return None, (jsonify({"error": f"{key} must be a string"}), 400)
    return val, None


@develop_bp.route("/")
def index():
    return "develop portal placeholder"



@api_develop_bp.route("/games", methods=["POST"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_create_game():
    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    title, err = _parse_optional_string(data, "title")
    if err:
        return err[0], err[1]
    description, err = _parse_optional_string(data, "description")
    if err:
        return err[0], err[1]

    status = "private"
    if "status" in data:
        s = data["status"]
        if not isinstance(s, str):
            return jsonify({"error": "status must be a string"}), 400
        status = s.strip().lower()
        if status not in ALLOWED_STATUSES:
            return jsonify({"error": "Invalid status"}), 400

    rej = _reject_if_visibility_without_copy(title, description, status)
    if rej:
        return rej

    game = Game(
        owner_id=current_user.id,
        title=(title.strip() or None) if title is not None else None,
        description=(description.strip() or None) if description is not None else None,
        status=status,
    )
    db.session.add(game)
    db.session.commit()
    return jsonify(_game_to_dict(game)), 201


@api_develop_bp.route("/games", methods=["GET"])
@login_required
def api_list_games():
    games = (
        Game.query.filter_by(owner_id=current_user.id)
        .order_by(Game.updated_at.desc())
        .all()
    )
    return jsonify([_game_to_dict(g) for g in games]), 200


@api_develop_bp.route("/games/<int:game_id>", methods=["GET"])
@login_required
def api_get_game(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    return jsonify(_game_to_dict(game)), 200


@api_develop_bp.route("/games/<int:game_id>", methods=["PATCH"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_patch_game(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    allowed = {"title", "description", "status"}
    if not data or not any(k in data for k in allowed):
        return jsonify({"error": "No updatable fields provided"}), 400

    next_title = game.title
    next_description = game.description
    next_status = game.status

    if "title" in data:
        t, e = _parse_optional_string(data, "title")
        if e:
            return e[0], e[1]
        if t is None:
            next_title = None
        else:
            next_title = t.strip() or None

    if "description" in data:
        d, e = _parse_optional_string(data, "description")
        if e:
            return e[0], e[1]
        if d is None:
            next_description = None
        else:
            next_description = d.strip() or None

    if "status" in data:
        s = data["status"]
        if not isinstance(s, str):
            return jsonify({"error": "status must be a string"}), 400
        next_status = s.strip().lower()
        if next_status not in ALLOWED_STATUSES:
            return jsonify({"error": "Invalid status"}), 400

    rej = _reject_if_visibility_without_copy(next_title, next_description, next_status)
    if rej:
        return rej

    game.title = next_title
    game.description = next_description
    game.status = next_status
    db.session.commit()
    return jsonify(_game_to_dict(game)), 200


def _cleanup_created_files(paths: list[Path]) -> None:
    for p in paths:
        try:
            if p.is_file():
                p.unlink()
        except OSError:
            pass


@api_develop_bp.route("/games/<int:game_id>/publish", methods=["POST"])
@login_required
@limiter.limit("10/hour", key_func=_rl_user_key)
def api_publish_game(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]

    if _is_blank(game.title) or _is_blank(game.description):
        return (
            jsonify({"error": "Title and description required before publishing"}),
            400,
        )

    scripts = (
        Script.query.join(Scene, Script.scene_id == Scene.id)
        .filter(Scene.game_id == game.id)
        .all()
    )
    sprites = (
        Sprite.query.filter_by(game_id=game.id).order_by(Sprite.id.asc()).all()
    )

    root = _project_root()
    pub_dir = root / "static" / "sprites" / "published" / str(game.id)
    created_files: list[Path] = []
    pending_deletes: list[str] = []

    try:
        pub_dir.mkdir(parents=True, exist_ok=True)

        for sp in sprites:
            old_rel = sp.published_image_path
            draft = sp.draft_image_path
            if not draft or not str(draft).strip():
                sp.published_image_path = None
                if old_rel:
                    pending_deletes.append(old_rel)
                continue

            src = _resolve_under_project_root(draft)
            if src is None or not src.is_file():
                db.session.rollback()
                _cleanup_created_files(created_files)
                return (
                    jsonify(
                        {"error": "Sprite draft image missing or invalid"},
                    ),
                    400,
                )

            suffix = src.suffix or ""
            dest_name = f"{sp.id}{suffix}"
            dest_rel = f"static/sprites/published/{game.id}/{dest_name}"
            dest_abs = pub_dir / dest_name
            shutil.copy2(src, dest_abs)
            created_files.append(dest_abs)
            sp.published_image_path = dest_rel
            old_norm = str(old_rel).replace("\\", "/") if old_rel else ""
            if old_norm and old_norm != dest_rel:
                pending_deletes.append(old_rel)

        for s in scripts:
            s.published_content = s.draft_content

        db.session.commit()
    except Exception:
        db.session.rollback()
        _cleanup_created_files(created_files)
        return jsonify({"error": "Publish failed"}), 500

    for old in pending_deletes:
        _delete_stored_file(old)

    return jsonify({"message": "Game published"}), 200


@api_develop_bp.route("/games/<int:game_id>", methods=["DELETE"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_delete_game(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]

    scene_ids = [row[0] for row in Scene.query.with_entities(Scene.id).filter_by(game_id=game_id).all()]
    if scene_ids:
        Script.query.filter(Script.scene_id.in_(scene_ids)).delete(synchronize_session=False)

    sprites = Sprite.query.filter_by(game_id=game_id).all()
    for sp in sprites:
        _delete_stored_file(sp.draft_image_path)
        _delete_stored_file(sp.published_image_path)

    Scene.query.filter_by(game_id=game_id).delete(synchronize_session=False)
    Sprite.query.filter_by(game_id=game_id).delete(synchronize_session=False)
    GameLike.query.filter_by(game_id=game_id).delete(synchronize_session=False)
    XPLog.query.filter_by(game_id=game_id).delete(synchronize_session=False)
    GamePurchase.query.filter_by(game_id=game_id).delete(synchronize_session=False)

    _delete_stored_file(game.thumbnail_path)

    db.session.delete(game)
    db.session.commit()
    return jsonify({"message": "Game deleted"}), 200




@api_develop_bp.route("/games/<int:game_id>/scenes", methods=["GET"])
@login_required
def api_list_scenes(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scenes = (
        Scene.query.filter_by(game_id=game.id)
        .order_by(Scene.order_index.asc(), Scene.id.asc())
        .all()
    )
    return jsonify([_scene_to_dict(s) for s in scenes]), 200


@api_develop_bp.route("/games/<int:game_id>/scenes", methods=["POST"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_create_scene(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data:
        return jsonify({"error": "name is required"}), 400
    name = data["name"]
    if not isinstance(name, str):
        return jsonify({"error": "name must be a string"}), 400
    name = name.strip()
    if not name:
        return jsonify({"error": "name must not be empty"}), 400

    current_count = Scene.query.filter_by(game_id=game.id).count()
    if current_count >= game.max_scenes:
        return (
            jsonify(
                {
                    "error": "Scene limit reached",
                    "max_scenes": game.max_scenes,
                }
            ),
            400,
        )

    max_order = (
        db.session.query(func.max(Scene.order_index))
        .filter(Scene.game_id == game.id)
        .scalar()
    )
    next_order = (max_order if max_order is not None else -1) + 1

    scene = Scene(game_id=game.id, name=name, order_index=next_order)
    db.session.add(scene)
    db.session.commit()
    return jsonify(_scene_to_dict(scene)), 201


@api_develop_bp.route("/games/<int:game_id>/scenes/<int:scene_id>", methods=["PATCH"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_patch_scene(game_id: int, scene_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data and "order_index" not in data:
        return jsonify({"error": "No updatable fields provided"}), 400

    if "name" in data:
        n = data["name"]
        if n is None:
            return jsonify({"error": "name must be a string"}), 400
        if not isinstance(n, str):
            return jsonify({"error": "name must be a string"}), 400
        n = n.strip()
        if not n:
            return jsonify({"error": "name must not be empty"}), 400
        scene.name = n

    if "order_index" in data:
        oi = data["order_index"]
        if oi is None:
            return jsonify({"error": "order_index must be an integer"}), 400
        if not isinstance(oi, int) or isinstance(oi, bool):
            return jsonify({"error": "order_index must be an integer"}), 400
        scene.order_index = oi

    db.session.commit()
    return jsonify(_scene_to_dict(scene)), 200


@api_develop_bp.route("/games/<int:game_id>/scenes/<int:scene_id>", methods=["DELETE"])
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_delete_scene(game_id: int, scene_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]

    Script.query.filter_by(scene_id=scene.id).delete(synchronize_session=False)
    db.session.delete(scene)
    db.session.commit()
    return jsonify({"message": "Scene deleted"}), 200



@api_develop_bp.route(
    "/games/<int:game_id>/scenes/<int:scene_id>/scripts", methods=["GET"]
)
@login_required
def api_list_scripts(game_id: int, scene_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]

    scripts = (
        Script.query.filter_by(scene_id=scene.id)
        .order_by(Script.id.asc())
        .all()
    )
    return jsonify([_script_to_list_item(s) for s in scripts]), 200


@api_develop_bp.route(
    "/games/<int:game_id>/scenes/<int:scene_id>/scripts", methods=["POST"]
)
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_create_script(game_id: int, scene_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data:
        return jsonify({"error": "name is required"}), 400
    name = data["name"]
    if not isinstance(name, str):
        return jsonify({"error": "name must be a string"}), 400
    name = name.strip()
    if not name:
        return jsonify({"error": "name must not be empty"}), 400

    script_count = Script.query.filter_by(scene_id=scene.id).count()
    if script_count >= game.max_scripts_per_scene:
        return (
            jsonify(
                {
                    "error": "Script limit reached for this scene",
                    "max_scripts_per_scene": game.max_scripts_per_scene,
                }
            ),
            400,
        )

    script = Script(
        scene_id=scene.id,
        name=name,
        draft_content=None,
        published_content=None,
    )
    db.session.add(script)
    db.session.commit()
    return jsonify(_script_to_mutation_response(script)), 201


@api_develop_bp.route(
    "/games/<int:game_id>/scenes/<int:scene_id>/scripts/<int:script_id>",
    methods=["PATCH"],
)
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_patch_script(game_id: int, scene_id: int, script_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]
    script, err3 = _get_script_for_scene(scene, script_id)
    if err3:
        return err3[0], err3[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data and "draft_content" not in data:
        return jsonify({"error": "No updatable fields provided"}), 400

    if "name" in data:
        n = data["name"]
        if n is None:
            return jsonify({"error": "name must be a string"}), 400
        if not isinstance(n, str):
            return jsonify({"error": "name must be a string"}), 400
        n = n.strip()
        if not n:
            return jsonify({"error": "name must not be empty"}), 400
        script.name = n

    if "draft_content" in data:
        dc = data["draft_content"]
        if dc is not None and not isinstance(dc, str):
            return jsonify({"error": "draft_content must be a string or null"}), 400
        script.draft_content = dc

    db.session.commit()
    return jsonify(_script_to_mutation_response(script)), 200


@api_develop_bp.route(
    "/games/<int:game_id>/scenes/<int:scene_id>/scripts/<int:script_id>",
    methods=["DELETE"],
)
@login_required
@limiter.limit("60/minute", key_func=_rl_user_key)
def api_delete_script(game_id: int, scene_id: int, script_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    scene, err2 = _get_scene_for_game(game, scene_id)
    if err2:
        return err2[0], err2[1]
    script, err3 = _get_script_for_scene(scene, script_id)
    if err3:
        return err3[0], err3[1]

    db.session.delete(script)
    db.session.commit()
    return jsonify({"message": "Script deleted"}), 200



@api_develop_bp.route("/games/<int:game_id>/sprites", methods=["GET"])
@login_required
def api_list_sprites(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    sprites = (
        Sprite.query.filter_by(game_id=game.id)
        .order_by(Sprite.id.asc())
        .all()
    )
    return jsonify([_sprite_to_api_dict(s) for s in sprites]), 200


@api_develop_bp.route("/games/<int:game_id>/sprites", methods=["POST"])
@login_required
@limiter.limit("30/minute", key_func=_rl_user_key)
def api_create_sprite(game_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data:
        return jsonify({"error": "name is required"}), 400
    name = data["name"]
    if not isinstance(name, str):
        return jsonify({"error": "name must be a string"}), 400
    name = name.strip()
    if not name:
        return jsonify({"error": "name must not be empty"}), 400

    count = Sprite.query.filter_by(game_id=game.id).count()
    if count >= game.max_sprites:
        return (
            jsonify(
                {
                    "error": "Sprite limit reached",
                    "max_sprites": game.max_sprites,
                }
            ),
            400,
        )

    sprite = Sprite(game_id=game.id, name=name)
    db.session.add(sprite)
    db.session.commit()
    return jsonify(_sprite_to_api_dict(sprite)), 201


@api_develop_bp.route(
    "/games/<int:game_id>/sprites/<int:sprite_id>/rename",
    methods=["PATCH"],
)
@login_required
@limiter.limit("30/minute", key_func=_rl_user_key)
def api_rename_sprite(game_id: int, sprite_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    sprite, err2 = _get_sprite_for_game(game, sprite_id)
    if err2:
        return err2[0], err2[1]

    if not request.is_json:
        return jsonify({"error": "Request body must be JSON"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON"}), 400

    if "name" not in data:
        return jsonify({"error": "name is required"}), 400
    n = data["name"]
    if n is None:
        return jsonify({"error": "name must be a string"}), 400
    if not isinstance(n, str):
        return jsonify({"error": "name must be a string"}), 400
    n = n.strip()
    if not n:
        return jsonify({"error": "name must not be empty"}), 400

    sprite.name = n
    db.session.commit()
    return jsonify(_sprite_to_api_dict(sprite)), 200


@api_develop_bp.route(
    "/games/<int:game_id>/sprites/<int:sprite_id>",
    methods=["PATCH"],
)
@login_required
@limiter.limit("30/minute", key_func=_rl_user_key)
def api_patch_sprite_image(game_id: int, sprite_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    sprite, err2 = _get_sprite_for_game(game, sprite_id)
    if err2:
        return err2[0], err2[1]

    file = request.files.get("image")
    if file is None or file.filename is None or str(file.filename).strip() == "":
        return jsonify({"error": "image file is required"}), 400

    safe_name = secure_filename(file.filename)
    if not safe_name:
        return jsonify({"error": "Invalid filename"}), 400

    if file.mimetype and file.mimetype != "image/png":
        return jsonify({"error": "Image must be PNG (image/png)"}), 400

    raw = file.read(SPRITE_PNG_MAX_BYTES + 1)
    if len(raw) > SPRITE_PNG_MAX_BYTES:
        return jsonify({"error": "Image must be at most 50KB"}), 400
    if len(raw) < len(SPRITE_PNG_MAGIC) or not raw.startswith(SPRITE_PNG_MAGIC):
        return jsonify({"error": "File must be a valid PNG image"}), 400

    root = _project_root()
    draft_dir = root / "static" / "sprites" / "drafts" / str(game.id)
    draft_dir.mkdir(parents=True, exist_ok=True)
    dest_abs = draft_dir / f"{sprite.id}.png"
    new_rel = f"static/sprites/drafts/{game.id}/{sprite.id}.png"
    old_draft = sprite.draft_image_path

    try:
        dest_abs.write_bytes(raw)
    except OSError:
        return jsonify({"error": "Failed to save image"}), 500

    sprite.draft_image_path = new_rel
    old_norm = _norm_stored_path(old_draft) if old_draft else None
    if old_norm and old_norm != new_rel:
        _delete_stored_file(old_draft)

    db.session.commit()
    return jsonify(_sprite_to_api_dict(sprite)), 200


@api_develop_bp.route(
    "/games/<int:game_id>/sprites/<int:sprite_id>",
    methods=["DELETE"],
)
@login_required
def api_delete_sprite(game_id: int, sprite_id: int):
    game, err = _get_owned_game(game_id)
    if err:
        return err[0], err[1]
    sprite, err2 = _get_sprite_for_game(game, sprite_id)
    if err2:
        return err2[0], err2[1]

    _delete_stored_file(sprite.draft_image_path)
    _delete_stored_file(sprite.published_image_path)
    db.session.delete(sprite)
    db.session.commit()
    return jsonify({"message": "Sprite deleted"}), 200
