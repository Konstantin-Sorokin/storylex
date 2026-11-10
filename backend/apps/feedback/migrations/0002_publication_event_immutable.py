from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("feedback", "0001_initial"), ("content", "0003_publication_guards")]
    operations = [migrations.RunSQL(
        "CREATE TRIGGER publication_event_immutable BEFORE UPDATE OR DELETE ON feedback_publicationevent "
        "FOR EACH ROW EXECUTE FUNCTION storylex_reject_immutable();",
        "DROP TRIGGER publication_event_immutable ON feedback_publicationevent;",
    )]
