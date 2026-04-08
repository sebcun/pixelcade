from datetime import datetime

from flask_login import UserMixin

from app.extensions import db


def _default_user_avatar():
    return {
        "base": None,
        "eyes": None,
        "hair": None,
        "accessory": None,
    }


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    level = db.Column(db.Integer, nullable=False, default=1)
    xp = db.Column(db.Integer, nullable=False, default=0)
    pixels = db.Column(db.Integer, nullable=False, default=0)
    avatar = db.Column(db.JSON, nullable=False, default=_default_user_avatar)

    def _avatar_payload(self):
        raw = self.avatar
        if not isinstance(raw, dict):
            return {}
        return dict(raw)

    def _set_avatar_part(self, key, value):
        payload = self._avatar_payload()
        payload[key] = value
        self.avatar = payload

    @property
    def avatar_base(self):
        return self._avatar_payload().get("base")

    @avatar_base.setter
    def avatar_base(self, value):
        self._set_avatar_part("base", value)

    @property
    def avatar_eyes(self):
        return self._avatar_payload().get("eyes")

    @avatar_eyes.setter
    def avatar_eyes(self, value):
        self._set_avatar_part("eyes", value)

    @property
    def avatar_hair(self):
        return self._avatar_payload().get("hair")

    @avatar_hair.setter
    def avatar_hair(self, value):
        self._set_avatar_part("hair", value)

    @property
    def avatar_accessory(self):
        return self._avatar_payload().get("accessory")

    @avatar_accessory.setter
    def avatar_accessory(self, value):
        self._set_avatar_part("accessory", value)


class Game(db.Model):
    """Owned game project. status: private | unlisted | public."""

    __tablename__ = "games"

    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), nullable=False, index=True
    )
    title = db.Column(db.String(255), nullable=True)
    description = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(32), nullable=False, default="private")
    play_count = db.Column(db.Integer, nullable=False, default=0)
    thumbnail_path = db.Column(db.String(512), nullable=True)
    max_scenes = db.Column(db.Integer, nullable=False, default=2)
    max_sprites = db.Column(db.Integer, nullable=False, default=10)
    max_scripts_per_scene = db.Column(db.Integer, nullable=False, default=3)
    default_scene_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "scenes.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_games_default_scene_id",
        ),
        nullable=True,
    )
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class Scene(db.Model):
    __tablename__ = "scenes"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(
        db.Integer, db.ForeignKey("games.id"), nullable=False, index=True
    )
    name = db.Column(db.String(255), nullable=False)
    order_index = db.Column(db.Integer, nullable=False, default=0)


class Script(db.Model):
    __tablename__ = "scripts"

    id = db.Column(db.Integer, primary_key=True)
    scene_id = db.Column(
        db.Integer, db.ForeignKey("scenes.id"), nullable=False, index=True
    )
    name = db.Column(db.String(255), nullable=False)
    draft_content = db.Column(db.Text, nullable=True)
    published_content = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class Sprite(db.Model):
    __tablename__ = "sprites"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(
        db.Integer, db.ForeignKey("games.id"), nullable=False, index=True
    )
    name = db.Column(db.String(255), nullable=False)
    draft_image_path = db.Column(db.String(512), nullable=True)
    published_image_path = db.Column(db.String(512), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class GameLike(db.Model):
    __tablename__ = "game_likes"

    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), primary_key=True, nullable=False
    )
    game_id = db.Column(
        db.Integer, db.ForeignKey("games.id"), primary_key=True, nullable=False
    )
    value = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


class XPLog(db.Model):
    __tablename__ = "xp_logs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), nullable=False, index=True
    )
    game_id = db.Column(
        db.Integer, db.ForeignKey("games.id"), nullable=False, index=True
    )
    amount = db.Column(db.Integer, nullable=False)
    tier = db.Column(db.String(16), nullable=True, index=True)
    awarded_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


class DailyCheckin(db.Model):
    __tablename__ = "daily_checkins"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), nullable=False, index=True
    )
    checked_in_date = db.Column(db.Date, nullable=False)


class AvatarItem(db.Model):
    __tablename__ = "avatar_items"

    id = db.Column(db.Integer, primary_key=True)
    category = db.Column(db.String(32), nullable=False, index=True)
    name = db.Column(db.String(255), nullable=False)
    image_path = db.Column(db.String(512), nullable=False)
    cost = db.Column(db.Integer, nullable=False, default=0)
    unlocked_by_default = db.Column(db.Boolean, nullable=False, default=True)


class UserAvatarItem(db.Model):
    __tablename__ = "user_avatar_items"

    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), primary_key=True, nullable=False
    )
    item_id = db.Column(
        db.Integer, db.ForeignKey("avatar_items.id"), primary_key=True, nullable=False
    )
    purchased_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


class GamePurchase(db.Model):
    __tablename__ = "game_purchases"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(
        db.Integer, db.ForeignKey("games.id"), nullable=False, index=True
    )
    user_id = db.Column(
        db.Integer, db.ForeignKey("users.id"), nullable=False, index=True
    )
    resource = db.Column(db.String(32), nullable=False, index=True)
    quantity = db.Column(db.Integer, nullable=False)
    cost = db.Column(db.Integer, nullable=False)
    purchased_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
