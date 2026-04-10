from flask import Blueprint, jsonify
from flask_limiter.util import get_remote_address
from flask_login import current_user, login_required

from app.extensions import db, limiter
from app.models import AvatarItem, User, UserAvatarItem

avatar_bp = Blueprint("avatar", __name__)
api_avatar_bp = Blueprint("api_avatar", __name__)

_CATEGORY_ORDER = ("base", "eyes", "hair", "accessory")


def _rl_avatar_user_key() -> str:
    if current_user.is_authenticated:
        return f"avatar:user:{current_user.id}"
    return f"ip:{get_remote_address()}"


def _serialize_item(item: AvatarItem, locked: bool) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "image_path": item.image_path,
        "cost": int(item.cost or 0),
        "unlocked_by_default": bool(item.unlocked_by_default),
        "locked": locked,
    }


@avatar_bp.route("/")
def customize():
    return "avatar customization placeholder"


@api_avatar_bp.route("/items", methods=["GET"])
def api_list_items():
    items = (
        AvatarItem.query.filter(AvatarItem.category.in_(_CATEGORY_ORDER))
        .order_by(AvatarItem.category, AvatarItem.id)
        .all()
    )

    owned_ids: set[int] = set()
    if current_user.is_authenticated:
        rows = (
            db.session.query(UserAvatarItem.item_id)
            .filter_by(user_id=current_user.id)
            .all()
        )
        owned_ids = {int(r[0]) for r in rows}

    grouped: dict[str, list[dict]] = {c: [] for c in _CATEGORY_ORDER}
    for item in items:
        if item.category not in grouped:
            continue
        if item.unlocked_by_default:
            locked = False
        elif not current_user.is_authenticated:
            locked = True
        else:
            locked = item.id not in owned_ids
        grouped[item.category].append(_serialize_item(item, locked))

    return jsonify(grouped), 200


@api_avatar_bp.route("/items/<int:item_id>/purchase", methods=["POST"])
@login_required
@limiter.limit("20/minute", key_func=_rl_avatar_user_key)
def api_purchase_item(item_id: int):
    item = db.session.get(AvatarItem, item_id)
    if item is None:
        return jsonify({"error": "Item not found"}), 404

    if item.unlocked_by_default:
        return jsonify({"error": "This item is already unlocked by default"}), 400

    user = db.session.get(User, current_user.id)
    if user is None:
        return jsonify({"error": "User not found"}), 404

    existing = UserAvatarItem.query.filter_by(
        user_id=user.id, item_id=item.id
    ).first()
    if existing is not None:
        return jsonify({"error": "You already own this item"}), 400

    cost = int(item.cost or 0)
    balance = int(user.pixels or 0)
    if balance < cost:
        return jsonify({"error": "Insufficient Pixels"}), 400

    user.pixels = balance - cost
    db.session.add(UserAvatarItem(user_id=user.id, item_id=item.id))
    db.session.commit()

    return (
        jsonify(
            {
                "message": "Item purchased",
                "new_pixel_balance": int(user.pixels),
                "item_id": item.id,
            }
        ),
        200,
    )
