from django.db import migrations


def create_head(apps, schema_editor):
    apps.get_model("content", "CatalogHead").objects.get_or_create(pk=1)


SQL = """
CREATE FUNCTION storylex_reject_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Published rows are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON content_publishedrevision
    FOR EACH ROW EXECUTE FUNCTION storylex_reject_immutable();
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON content_packartifact
    FOR EACH ROW EXECUTE FUNCTION storylex_reject_immutable();
CREATE TRIGGER catalog_immutable BEFORE UPDATE OR DELETE ON content_catalogrevision
    FOR EACH ROW EXECUTE FUNCTION storylex_reject_immutable();

CREATE FUNCTION storylex_protect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Published identities cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
        RAISE EXCEPTION 'Identity ownership cannot change' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'content_lesson' THEN
        IF NEW.section_id IS DISTINCT FROM OLD.section_id THEN
            RAISE EXCEPTION 'Lesson cannot move' USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NEW.lesson_id IS DISTINCT FROM OLD.lesson_id OR NEW.sense_key IS DISTINCT FROM OLD.sense_key THEN
            RAISE EXCEPTION 'Item identity cannot change' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER lesson_identity BEFORE UPDATE OR DELETE ON content_lesson
    FOR EACH ROW EXECUTE FUNCTION storylex_protect_identity();
CREATE TRIGGER item_identity BEFORE UPDATE OR DELETE ON content_learningitem
    FOR EACH ROW EXECUTE FUNCTION storylex_protect_identity();

CREATE FUNCTION storylex_check_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM content_publishedrevision WHERE id = NEW.current_revision_id AND product_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'Revision belongs to another Product' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER product_current_revision BEFORE INSERT OR UPDATE ON content_product
    FOR EACH ROW EXECUTE FUNCTION storylex_check_current_revision();
"""

REVERSE_SQL = """
DROP TRIGGER product_current_revision ON content_product;
DROP FUNCTION storylex_check_current_revision();
DROP TRIGGER item_identity ON content_learningitem;
DROP TRIGGER lesson_identity ON content_lesson;
DROP FUNCTION storylex_protect_identity();
DROP TRIGGER catalog_immutable ON content_catalogrevision;
DROP TRIGGER artifact_immutable ON content_packartifact;
DROP TRIGGER revision_immutable ON content_publishedrevision;
DROP FUNCTION storylex_reject_immutable();
"""


class Migration(migrations.Migration):
    dependencies = [("content", "0002_catalogrevision_product_availability_and_more")]
    operations = [
        migrations.RunPython(create_head, migrations.RunPython.noop),
        migrations.RunSQL(SQL, REVERSE_SQL),
    ]
