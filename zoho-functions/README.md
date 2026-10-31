# Zoho Functions

Use these functions when you want the Lead/Contact button to update the fields silently instead of opening the widget.

## Lead Button

Create a standalone function named:

```text
generate_lead_review_link
```

Argument:

```text
lead_id
```

Map `lead_id` to the current Lead record ID when configuring the button.

Use the code in:

```text
generate_lead_review_link.deluge
```

## Contact Button

Create a standalone function named:

```text
generate_contact_review_link
```

Argument:

```text
contact_id
```

Map `contact_id` to the current Contact record ID when configuring the button.

Use the code in:

```text
generate_contact_review_link.deluge
```

## Install Action

Create the hidden Server Connection Key custom property first, then use:

```text
install_generate_server_connection_key.deluge
```

This generates the per-org server key automatically when the extension is installed.

## Scheduled Sync

Create a scheduled function named:

```text
sync_pending_review_updates
```

Use:

```text
sync_pending_review_updates.deluge
```

Recommended schedule: every 5 to 15 minutes. It pulls opened-link events from the backend and updates the Zoho fields from inside the installed CRM org.

## Follow-up Tasks

Create a scheduled function named:

```text
create_review_followup_tasks
```

Use:

```text
create_review_followup_tasks.deluge
```

Recommended schedule: once per day. It creates Zoho Tasks for generated links that have not been opened, then marks those records in the backend so duplicate Tasks are not created.

The backend URL is set to the Koyeb service in the templates:

```text
https://greview.koyeb.app
```
